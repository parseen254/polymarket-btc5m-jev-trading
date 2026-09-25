import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchJson } from "../src/adapters/polymarket/wire.js";
import { loadDotEnv } from "../src/loadEnv.js";
import { takerFeePerShare } from "../src/policy.js";
import {
  arg,
  argList,
  f3,
  fairUp,
  klines,
  pct,
  pool,
  rangeAverager,
  sigmaPerSecBefore,
  table,
  twapFairUp,
} from "./lib/history.js";

/**
 * Historical check of a fair-value edge on BTC 5m Up/Down, no Jev calls.
 *
 * For each past window: official winner (Gamma), the UP price path (CLOB
 * prices-history, ~1 point/min) and Binance 1s BTC. At each price point the model
 * prices UP as a digital option:
 *
 *   P(UP) = Φ( ln(S_t / S_0) / (σ · √τ) )
 *
 * S_0 = Binance at window start, τ = seconds left, σ = per-√second vol from the
 * previous hour of 1m returns. Then: does the model forecast better than the
 * market, where is the market miscalibrated, and does trading the gap survive fees?
 *
 * The default `twap` model follows Polymarket's rule (Chainlink 60s TWAP at the close
 * ≥ 60s TWAP at the open, computed here on Binance); `--model spot` compares spot prices.
 *
 * Usage: tsx scripts/backtest-history.ts [--days 2] [--spread 0.01] [--fee-rate 0.07]
 *        [--lags 0,5,15,30] [--model twap|spot]
 */

loadDotEnv();

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const days = arg("--days", 2);
/** Half-spread paid over the history price to lift the ask. */
const halfSpread = arg("--spread", 0.01);
const feeRate = arg("--fee-rate", 0.07);
const cachePath = resolve("data/backtest-cache.json");
const fairModel = process.argv.includes("--model")
  ? String(process.argv[process.argv.indexOf("--model") + 1])
  : "twap";

type Window = {
  ts: number;
  winner: "UP" | "DOWN";
  priceToBeat: number | null;
  finalPrice: number | null;
  upPath: { t: number; p: number }[];
};

async function loadWindow(ts: number): Promise<Window | null> {
  const ev = (await fetchJson(`${GAMMA}/events?slug=btc-updown-5m-${ts}`).catch(() => null)) as
    | Array<{
        eventMetadata?: { priceToBeat?: number; finalPrice?: number } | null;
        markets?: Array<{ outcomes: string; outcomePrices: string; clobTokenIds: string; closed: boolean }>;
      }>
    | null;
  const m = ev?.[0]?.markets?.[0];
  if (!m?.closed) return null;
  const outcomes = (JSON.parse(m.outcomes) as string[]).map((o) => o.toLowerCase());
  const prices = (JSON.parse(m.outcomePrices) as string[]).map(Number);
  const tokens = JSON.parse(m.clobTokenIds) as string[];
  const iUp = outcomes.indexOf("up");
  if (iUp < 0) return null;
  const up = prices[iUp]!;
  const winner = up >= 0.99 ? "UP" : up <= 0.01 ? "DOWN" : null;
  if (!winner) return null;
  const hist = (await fetchJson(
    `${CLOB}/prices-history?market=${tokens[iUp]}&startTs=${ts}&endTs=${ts + 300}&fidelity=1`,
  ).catch(() => null)) as { history?: { t: number; p: number }[] } | null;
  return {
    ts,
    winner,
    priceToBeat: ev?.[0]?.eventMetadata?.priceToBeat ?? null,
    finalPrice: ev?.[0]?.eventMetadata?.finalPrice ?? null,
    upPath: (hist?.history ?? []).filter((h) => h.t >= ts && h.t < ts + 300),
  };
}

async function main(): Promise<void> {
  const end = Math.floor(Date.now() / 1000 / 300) * 300 - 600; // skip unresolved
  const start = end - days * 86_400;
  const all: number[] = [];
  for (let ts = start; ts < end; ts += 300) all.push(ts);

  const cache: Record<string, Window> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf8"))
    : {};
  const todo = all.filter((ts) => !cache[ts]);
  console.error(`windows: ${all.length} (${todo.length} to fetch)`);
  const fetched = await pool(todo, 8, loadWindow);
  for (const w of fetched) if (w) cache[w.ts] = w;
  mkdirSync(resolve("data"), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));

  const windows = all.map((ts) => cache[ts]).filter((w): w is Window => w != null && w.upPath.length > 0);
  console.error(`fetching Binance 1s/1m for ${days}d…`);
  const [sec, min] = await Promise.all([klines("1s", start - 120, end + 300), klines("1m", start - 3600, end + 300)]);
  const avg = rangeAverager(sec, start - 120, end + 300);
  const priceAt = (w: Window, t: number, st: number, s0: number, sigma: number) => {
    const tau = w.ts + 300 - t;
    return fairModel === "twap"
      ? twapFairUp({ st, k: s0, sigmaPerSec: sigma, tau, partial: tau < 60 ? avg(w.ts + 240, t + 1) : null })
      : fairUp(st, s0, sigma, tau);
  };

  type Obs = {
    w: Window;
    t: number;
    tau: number;
    mkt: number;
    model: number;
    y: number;
    s0: number;
    sigmaPerSec: number;
  };
  const obs: Obs[] = [];
  for (const w of windows) {
    const s0 = fairModel === "twap" ? avg(w.ts - 60, w.ts) : sec.get(w.ts);
    if (!s0 || !Number.isFinite(s0)) continue;
    const sigmaPerSec = sigmaPerSecBefore(min, w.ts);
    if (sigmaPerSec == null) continue;
    for (const h of w.upPath) {
      const tau = w.ts + 300 - h.t;
      const st = sec.get(h.t);
      if (!st || tau < 15) continue;
      const model = priceAt(w, h.t, st, s0, sigmaPerSec);
      obs.push({ w, t: h.t, tau, mkt: h.p, model, y: w.winner === "UP" ? 1 : 0, s0, sigmaPerSec });
    }
  }
  const upRate = windows.filter((w) => w.winner === "UP").length / windows.length;
  console.log(
    `${windows.length} resolved windows over ${days}d, ${obs.length} price points. UP won ${pct(upRate)}.\n`,
  );

  // Can Binance stand in for Chainlink? Compare its direction with the official result.
  let signN = 0, spotBad = 0, twapBad = 0;
  for (const w of windows) {
    const a = sec.get(w.ts), b = sec.get(w.ts + 299);
    const k = avg(w.ts - 60, w.ts), x = avg(w.ts + 240, w.ts + 300);
    if (!a || !b || !Number.isFinite(k) || !Number.isFinite(x)) continue;
    signN++;
    if ((b >= a ? "UP" : "DOWN") !== w.winner) spotBad++;
    if ((x >= k ? "UP" : "DOWN") !== w.winner) twapBad++;
  }
  console.log(
    `Binance direction vs official result: spot→spot wrong in ${pct(spotBad / signN)}, 60s avg→60s avg wrong in ${pct(twapBad / signN)} (${signN} windows).\n`,
  );

  // 1) Forecast quality by time left.
  const buckets = [[240, 300], [180, 240], [120, 180], [60, 120], [15, 60]] as const;
  console.log("Brier by seconds left (lower = better)");
  table(
    ["left", "n", "model", "market", "blend"],
    buckets.map(([lo, hi]) => {
      const xs = obs.filter((o) => o.tau >= lo && o.tau < hi);
      const b = (f: (o: Obs) => number) => xs.reduce((s, o) => s + (f(o) - o.y) ** 2, 0) / xs.length;
      return [`${lo}-${hi}s`, xs.length, f3(b((o) => o.model)), f3(b((o) => o.mkt)), f3(b((o) => (o.model + o.mkt) / 2))];
    }),
  );

  // 2) Market calibration (favorite–longshot): price bucket vs how often UP won.
  const rel: (string | number)[][] = [];
  for (const [lo, hi] of [[0, 0.1], [0.1, 0.3], [0.3, 0.45], [0.45, 0.55], [0.55, 0.7], [0.7, 0.9], [0.9, 1.01]] as const) {
    const xs = obs.filter((o) => o.mkt >= lo && o.mkt < hi && o.tau >= 60);
    if (xs.length < 5) continue;
    const mean = xs.reduce((s, o) => s + o.mkt, 0) / xs.length;
    const hit = xs.reduce((s, o) => s + o.y, 0) / xs.length;
    rel.push([`${lo}-${Math.min(hi, 1)}`, xs.length, f3(mean), pct(hit), (hit - mean >= 0 ? "+" : "") + f3(hit - mean)]);
  }
  console.log("Market calibration (UP price vs actual UP rate, ≥60s left)");
  table(["price", "n", "avg price", "actual", "gap"], rel);

  // 3) Taker sim: buy the side where model − ask − fee ≥ θ, first per window, ≥90s left.
  //    `lag` feeds the model BTC from `lag` seconds before the quote. If profit
  //    disappears with a few seconds of lag, the "edge" is just reading stale
  //    history prices faster than they update — a latency race, not a durable edge.
  const sims: (string | number)[][] = [];
  for (const lag of argList("--lags", [0])) {
    for (const theta of [0, 0.05, 0.1, 0.15]) {
      const seen = new Set<number>();
      let n = 0, wins = 0, pnl = 0, pnl2 = 0;
      for (const o of obs) {
        if (seen.has(o.w.ts) || o.tau < 90) continue;
        const st = sec.get(o.t - lag);
        if (!st) continue;
        const model = priceAt(o.w, o.t - lag, st, o.s0, o.sigmaPerSec);
        for (const side of ["UP", "DOWN"] as const) {
          const ask = (side === "UP" ? o.mkt : 1 - o.mkt) + halfSpread;
          const p = side === "UP" ? model : 1 - model;
          if (ask <= 0 || ask >= 1) continue;
          const fee = takerFeePerShare(ask, feeRate);
          if (p - ask - fee < theta) continue;
          seen.add(o.w.ts);
          const win = o.w.winner === side;
          const r = (win ? 1 : 0) - ask - fee;
          n++; wins += win ? 1 : 0; pnl += r; pnl2 += r * r;
          break;
        }
      }
      const mean = n ? pnl / n : NaN;
      const sd = n > 1 ? Math.sqrt((pnl2 - n * mean * mean) / (n - 1)) : NaN;
      sims.push([lag, theta, n, n ? pct(wins / n) : "-", pnl.toFixed(2), f3(mean), f3(mean / (sd / Math.sqrt(n)))]);
    }
  }
  console.log(`Taker sim: 1 share, ask = price + ${halfSpread}, fee rate ${feeRate}, ≥90s left`);
  table(["lag s", "θ", "trades", "win", "net $", "$/trade", "t-stat"], sims);
  console.log("t-stat > 2 over hundreds of trades is the minimum bar; re-run on fresh days before trusting it.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
