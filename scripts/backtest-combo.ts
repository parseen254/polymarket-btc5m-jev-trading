import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { typeSafeJudge } from "../src/adapters/jev/typesafe.js";
import { fetchJson } from "../src/adapters/polymarket/wire.js";
import type { FactsForJev, Judge } from "../src/domain.js";
import { loadDotEnv } from "../src/loadEnv.js";
import { takerFeePerShare } from "../src/policy.js";
import {
  arg,
  argList,
  binanceBase,
  f3,
  klines,
  pct,
  pool,
  rangeAverager,
  sigmaPerSecBefore,
  table,
  twapFairUp,
} from "./lib/history.js";

/**
 * Does Jev add anything on top of the TWAP model? Replays past windows (from
 * data/backtest-cache.json — run `npm run backtest` for the same period first), builds
 * the facts the bot would send Jev at each ~1/min price point with ≥ 90 s left, asks
 * Jev (OpenRouter or TypeSafe, cached in data/jev-hist-cache.json), and compares
 * entry rules on the same points:
 *
 *   twap      buy the side where P_twap − ask − fee ≥ θ
 *   jev       same with Jev's probabilities
 *   agree     twap rule, but only if Jev also gives that side ≥ 50 %
 *   blend w   same with w·P_twap + (1 − w)·P_jev
 *
 * ask = history price + `--spread`; one share, first qualifying point per window.
 *
 * Usage: tsx scripts/backtest-combo.ts [--days 2.95] [--ago 0] [--lag 2]
 *        [--thetas 0,0.05,0.1,0.15] [--spread 0.01] [--concurrency 6]
 */

loadDotEnv();

const days = arg("--days", 2.95);
const lag = arg("--lag", 2);
const thetas = argList("--thetas", [0, 0.05, 0.1, 0.15]);
const halfSpread = arg("--spread", 0.01);
const feeRate = arg("--fee-rate", 0.07);
const concurrency = arg("--concurrency", 6);

type Window = { ts: number; winner: "UP" | "DOWN"; upPath: { t: number; p: number }[] };
type Point = { w: Window; t: number; tau: number; mkt: number; pTwap: number; facts: FactsForJev; key: string };

function jevFromEnv(): Judge {
  const provider = (process.env.JEV_PROVIDER ?? "").toLowerCase() === "typesafe" || !process.env.OPENROUTER_API_KEY
    ? "typesafe"
    : "openrouter";
  const apiKey = (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.TYPESAFE_API_KEY)?.trim();
  if (!apiKey) throw new Error("set OPENROUTER_API_KEY or TYPESAFE_API_KEY in .env");
  return typeSafeJudge({ apiKey, provider, model: process.env.JEV_MODEL?.trim() || undefined });
}

const quote = (p: number) => ({
  mid: p,
  bid: Math.max(0.01, Math.round((p - halfSpread) * 100) / 100),
  ask: Math.min(0.99, Math.round((p + halfSpread) * 100) / 100),
  spread: 2 * halfSpread,
  lastTrade: p,
});

async function main(): Promise<void> {
  const cachePath = resolve("data/backtest-cache.json");
  if (!existsSync(cachePath)) throw new Error("run `npm run backtest -- --days N` for this period first");
  const cache: Record<string, Window> = JSON.parse(readFileSync(cachePath, "utf8"));
  const end = Math.floor(Date.now() / 1000 / 300) * 300 - 600 - Math.round((arg("--ago", 0) * 86_400) / 300) * 300;
  const start = end - Math.round((days * 86_400) / 300) * 300;
  const windows: Window[] = [];
  for (let ts = start; ts < end; ts += 300) if (cache[ts]?.upPath.length) windows.push(cache[ts]!);
  console.error(`${windows.length} cached windows in range; fetching Binance…`);

  const [sec, min] = await Promise.all([klines("1s", start - 120, end + 300), klines("1m", start - 3600, end + 300)]);
  const avg = rangeAverager(sec, start - 120, end + 300);
  // 1h candles for the 24h stats the bot sends Jev.
  const hours: unknown[][] = [];
  for (let s = start - 90_000; s < end; s += 1000 * 3600) {
    hours.push(...((await fetchJson(
      `${binanceBase()}/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${s * 1000}&endTime=${Math.min(end, s + 1000 * 3600) * 1000 - 1}&limit=1000`,
    )) as unknown[][]));
  }
  const h24 = (t: number) => {
    const rows = hours.filter((k) => Number(k[0]) / 1000 >= t - 86_400 && Number(k[0]) / 1000 < t);
    return {
      open: Number(rows[0]?.[1] ?? NaN),
      high: Math.max(...rows.map((k) => Number(k[2]))),
      low: Math.min(...rows.map((k) => Number(k[3]))),
      vol: rows.reduce((s, k) => s + Number(k[7]), 0),
    };
  };

  const points: Point[] = [];
  for (const w of windows) {
    const k = avg(w.ts - 60, w.ts);
    const sigma = sigmaPerSecBefore(min, w.ts);
    const open1m = min.get(w.ts) ?? null;
    if (!Number.isFinite(k) || sigma == null) continue;
    for (const h of w.upPath) {
      const ti = h.t - lag;
      const tau = w.ts + 300 - ti;
      const st = sec.get(ti);
      if (!st || w.ts + 300 - h.t < 90) continue;
      const pTwap = twapFairUp({ st, k, sigmaPerSec: sigma, tau, partial: tau < 60 ? avg(w.ts + 240, ti + 1) : null });
      const day = h24(ti);
      const facts: FactsForJev = {
        market: {
          slug: `btc-updown-5m-${w.ts}`,
          question: `Bitcoin Up or Down (5m window starting ${new Date(w.ts * 1000).toISOString()})`,
          endsAt: new Date((w.ts + 300) * 1000).toISOString(),
          volume24hUsd: 0,
          up: quote(h.p),
          down: quote(1 - h.p),
        },
        btc: {
          last: st,
          change24hPct: ((st - day.open) / day.open) * 100,
          high24h: day.high,
          low24h: day.low,
          volume24hQuote: day.vol,
          moveVsWindowOpenPct: open1m ? ((st - open1m) / open1m) * 100 : 0,
          windowOpen: open1m,
        },
        session: { secondsRemaining: tau, windowLengthSec: 300, position: { kind: "flat" } },
        meta: { marketSource: "live", spotSource: "live", composedAt: new Date(ti * 1000).toISOString() },
      };
      points.push({ w, t: h.t, tau, mkt: h.p, pTwap, facts, key: `${w.ts}:${h.t}:${lag}` });
    }
  }

  // Ask Jev (cached).
  const jevCachePath = resolve("data/jev-hist-cache.json");
  const jevCache: Record<string, number> = existsSync(jevCachePath) ? JSON.parse(readFileSync(jevCachePath, "utf8")) : {};
  const todo = points.filter((p) => jevCache[p.key] == null);
  console.error(`${points.length} decision points · asking Jev for ${todo.length}…`);
  const jev = jevFromEnv();
  let failed = 0, done = 0;
  await pool(todo, concurrency, async (p) => {
    try {
      const o = await jev.ask(p.facts);
      jevCache[p.key] = o.probs?.UP ?? (o.side === "UP" ? o.confidence : 1 - o.confidence);
    } catch {
      failed++;
    }
    if (++done % 250 === 0) {
      console.error(`  ${done}/${todo.length}`);
      mkdirSync(resolve("data"), { recursive: true });
      writeFileSync(jevCachePath, JSON.stringify(jevCache));
    }
  });
  mkdirSync(resolve("data"), { recursive: true });
  writeFileSync(jevCachePath, JSON.stringify(jevCache));
  const usable = points.filter((p) => jevCache[p.key] != null);
  const nWin = new Set(usable.map((p) => p.w.ts)).size;
  console.log(
    `${usable.length} decision points in ${nWin} windows (${failed} Jev calls failed) · data delay ${lag}s · ≥90 s left\n`,
  );

  // Forecast quality at the same points.
  const y = (p: Point) => (p.w.winner === "UP" ? 1 : 0);
  const brier = (f: (p: Point) => number) => usable.reduce((s, p) => s + (f(p) - y(p)) ** 2, 0) / usable.length;
  console.log("Brier at entry points (lower = better)");
  table(
    ["market", "twap", "jev", "blend 0.5", "blend 0.8"],
    [[
      f3(brier((p) => p.mkt)),
      f3(brier((p) => p.pTwap)),
      f3(brier((p) => jevCache[p.key]!)),
      f3(brier((p) => 0.5 * p.pTwap + 0.5 * jevCache[p.key]!)),
      f3(brier((p) => 0.8 * p.pTwap + 0.2 * jevCache[p.key]!)),
    ]],
  );

  type Rule = { name: string; prob: (p: Point) => number; gate?: (p: Point, side: "UP" | "DOWN") => boolean };
  const rules: Rule[] = [
    { name: "twap", prob: (p) => p.pTwap },
    { name: "jev", prob: (p) => jevCache[p.key]! },
    {
      name: "agree",
      prob: (p) => p.pTwap,
      gate: (p, side) => (side === "UP" ? jevCache[p.key]! : 1 - jevCache[p.key]!) >= 0.5,
    },
    { name: "blend 0.5", prob: (p) => 0.5 * p.pTwap + 0.5 * jevCache[p.key]! },
    { name: "blend 0.8", prob: (p) => 0.8 * p.pTwap + 0.2 * jevCache[p.key]! },
  ];
  const rows: (string | number)[][] = [];
  for (const rule of rules) {
    for (const theta of thetas) {
      const seen = new Set<number>();
      let n = 0, wins = 0, pnl = 0, pnl2 = 0;
      for (const p of usable) {
        if (seen.has(p.w.ts)) continue;
        const pu = rule.prob(p);
        for (const side of ["UP", "DOWN"] as const) {
          const ask = (side === "UP" ? p.mkt : 1 - p.mkt) + halfSpread;
          if (ask <= 0 || ask >= 1) continue;
          const fee = takerFeePerShare(ask, feeRate);
          const ps = side === "UP" ? pu : 1 - pu;
          if (ps - ask - fee < theta) continue;
          if (rule.gate && !rule.gate(p, side)) continue;
          seen.add(p.w.ts);
          const win = p.w.winner === side;
          const r = (win ? 1 : 0) - ask - fee;
          n++; wins += win ? 1 : 0; pnl += r; pnl2 += r * r;
          break;
        }
      }
      const mean = n ? pnl / n : NaN;
      const sd = n > 1 ? Math.sqrt((pnl2 - n * mean * mean) / (n - 1)) : NaN;
      rows.push([rule.name, theta, n, n ? pct(wins / n) : "-", pnl.toFixed(2), f3(mean), f3(mean / (sd / Math.sqrt(n)))]);
    }
  }
  console.log(`Taker sim: 1 share at price + ${halfSpread}, fee rate ${feeRate}, first qualifying point per window`);
  table(["rule", "θ", "trades", "win", "net $", "$/trade", "t"], rows);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
