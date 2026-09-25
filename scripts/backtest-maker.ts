import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchJson } from "../src/adapters/polymarket/wire.js";
import { loadDotEnv } from "../src/loadEnv.js";
import {
  arg,
  argList,
  f3,
  fairUp,
  klines,
  pct,
  pool,
  sigmaPerSecBefore,
  table,
} from "./lib/history.js";

/**
 * Try to break the maker thesis on real order flow.
 *
 * Replays every taker trade in past BTC 5m windows (data-api /trades, taker-only)
 * against a hypothetical resting BID on each outcome, priced off the digital-option
 * fair value with a delay of L seconds:
 *
 *   bid_UP   = floor₀.₀₁( fairUp(S_{t−L}) − δ )
 *   bid_DOWN = floor₀.₀₁( 1 − fairUp(S_{t−L}) − δ )
 *
 * Two quoting modes:
 *   model — bid at fair − δ (the model sets the price)
 *   touch — join the market's best bid, capped at fair − δ (the model only guards).
 *           Best bid is inferred from earlier trades: a taker SELL of X at p hit the
 *           X bid at p; a taker BUY of the other side at p implies an X bid at 1 − p.
 *
 * Our bid on outcome X fills when a taker sells X (directly, or by buying the other
 * side through a complementary mint):
 *   - at a price below our bid → we'd have been hit first; full fill (up to cap)
 *   - at exactly our bid       → we share the level; fill q × size (queue share)
 * Quote size Q shares per outcome per second. PnL is held to the official result;
 * makers pay no fee and get a rebate of rebateRate × feeRate × p(1−p) per share.
 *
 * Usage: tsx scripts/backtest-maker.ts [--days 3] [--deltas 0.01,0.02,0.03,0.05]
 *        [--lags 0,2,5] [--queues 0,0.1,0.25] [--inv 0,50,20] [--size 10] [--stop 20] [--ago 0]
 *        [--rebate-rate 0.2] [--fee-rate 0.07]
 */

loadDotEnv();

const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";

const days = arg("--days", 3);
const deltas = argList("--deltas", [0.01, 0.02, 0.03, 0.05]);
const lags = argList("--lags", [0, 2, 5]);
const queues = argList("--queues", [0, 0.1, 0.25]);
/** Touch mode: ignore a best-bid estimate older than this. */
const touchMaxAgeSec = arg("--touch-age", 5);
/** Inventory limit: stop bidding a side once it leads the other by this many shares (0 = no limit). */
const invLimits = argList("--inv", [0, 50, 20]);
const modes = (process.argv.includes("--modes")
  ? String(process.argv[process.argv.indexOf("--modes") + 1]).split(",")
  : ["model", "touch"]) as Mode[];
const quoteSize = arg("--size", 10);
/** Stop quoting this many seconds before the close. */
const stopBefore = arg("--stop", 20);
const rebateRate = arg("--rebate-rate", 0.2);
const feeRate = arg("--fee-rate", 0.07);
const cachePath = resolve("data/maker-cache.json");

/** [unixSec, takerSide (1=BUY,0=SELL), outcome (1=UP,0=DOWN), price, size] */
type Tape = [number, 0 | 1, 0 | 1, number, number][];
type MakerWindow = { ts: number; winner: "UP" | "DOWN"; tape: Tape };

async function loadMakerWindow(ts: number): Promise<MakerWindow | null> {
  const ev = (await fetchJson(`${GAMMA}/events?slug=btc-updown-5m-${ts}`).catch(() => null)) as
    | Array<{ markets?: Array<{ conditionId: string; outcomes: string; outcomePrices: string; closed: boolean }> }>
    | null;
  const m = ev?.[0]?.markets?.[0];
  if (!m?.closed) return null;
  const outcomes = (JSON.parse(m.outcomes) as string[]).map((o) => o.toLowerCase());
  const up = (JSON.parse(m.outcomePrices) as string[]).map(Number)[outcomes.indexOf("up")];
  const winner = up != null && up >= 0.99 ? "UP" : up != null && up <= 0.01 ? "DOWN" : null;
  if (!winner) return null;

  const tape: Tape = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const page = (await fetchJson(
      `${DATA}/trades?market=${m.conditionId}&limit=1000&offset=${offset}`,
    ).catch(() => null)) as
      | Array<{ timestamp: number; side: string; outcome: string; price: number; size: number }>
      | null;
    if (!Array.isArray(page)) return null;
    for (const t of page) {
      if (t.timestamp < ts || t.timestamp >= ts + 300) continue;
      tape.push([
        t.timestamp,
        t.side === "BUY" ? 1 : 0,
        t.outcome.toLowerCase() === "up" ? 1 : 0,
        Number(t.price),
        Number(t.size),
      ]);
    }
    if (page.length < 1000) break;
  }
  tape.sort((a, b) => a[0] - b[0]);
  return { ts, winner, tape };
}

type Result = {
  windows: number;
  shares: number;
  cost: number;
  payout: number;
  rebate: number;
  perWindow: number[];
  /** Shares filled with the side that went on to lose. */
  loserShares: number;
  /** Net inventory skew: |UP − DOWN| shares summed per window. */
  skew: number;
};

type Mode = "model" | "touch";

function simulate(
  windows: MakerWindow[],
  sec: Map<number, number>,
  min: Map<number, number>,
  mode: Mode,
  delta: number,
  lag: number,
  queue: number,
  invLimit: number,
): Result {
  const r: Result = { windows: 0, shares: 0, cost: 0, payout: 0, rebate: 0, perWindow: [], loserShares: 0, skew: 0 };
  for (const w of windows) {
    const s0 = sec.get(w.ts);
    const sigma = sigmaPerSecBefore(min, w.ts);
    if (!s0 || sigma == null) continue;
    r.windows++;
    const held = { UP: 0, DOWN: 0 };
    let cost = 0, rebate = 0;
    const used = new Map<string, number>(); // `${sec}:${side}` → shares filled this second
    const touch = { UP: { p: 0, t: -Infinity }, DOWN: { p: 0, t: -Infinity } };
    for (const [t, takerBuy, isUp, p, size] of w.tape) {
      if (t >= w.ts + 300 - stopBefore) break;
      // Which bid did this taker hit, at what price for that outcome?
      const side: "UP" | "DOWN" = takerBuy ? (isUp ? "DOWN" : "UP") : isUp ? "UP" : "DOWN";
      const sellPrice = Math.round((takerBuy ? 1 - p : p) * 100) / 100;
      const prevTouch = touch[side];
      touch[side] = { p: sellPrice, t }; // visible to later trades only
      const sq = sec.get(t - lag);
      if (!sq) continue;
      const fair = fairUp(sq, s0, sigma, w.ts + 300 - (t - lag));
      const fairSide = side === "UP" ? fair : 1 - fair;
      const cap = Math.floor((fairSide - delta) * 100 + 1e-9) / 100;
      let bid = cap;
      if (mode === "touch") {
        if (t - prevTouch.t > touchMaxAgeSec) continue;
        bid = Math.min(prevTouch.p, cap);
      }
      if (bid < 0.01 || bid > 0.99 || bid < sellPrice - 1e-9) continue;
      const atLevel = Math.abs(bid - sellPrice) < 1e-9;
      if (atLevel && queue <= 0) continue;
      const other = side === "UP" ? "DOWN" : "UP";
      if (invLimit > 0 && held[side] - held[other] >= invLimit) continue;
      const key = `${t}:${side}`;
      const avail = atLevel ? size * queue : size;
      const qty = Math.min(avail, quoteSize - (used.get(key) ?? 0));
      if (qty <= 0) continue;
      used.set(key, (used.get(key) ?? 0) + qty);
      held[side] += qty;
      cost += qty * bid;
      rebate += qty * rebateRate * feeRate * bid * (1 - bid);
    }
    const shares = held.UP + held.DOWN;
    if (shares === 0) {
      r.perWindow.push(0);
      continue;
    }
    const payout = held[w.winner];
    r.shares += shares;
    r.cost += cost;
    r.payout += payout;
    r.rebate += rebate;
    r.loserShares += shares - payout;
    r.skew += Math.abs(held.UP - held.DOWN);
    r.perWindow.push(payout - cost + rebate);
  }
  return r;
}

async function main(): Promise<void> {
  // --ago shifts the test period back N days (out-of-sample checks).
  const end = Math.floor(Date.now() / 1000 / 300) * 300 - 600 - arg("--ago", 0) * 86_400;
  const start = end - days * 86_400;
  const all: number[] = [];
  for (let ts = start; ts < end; ts += 300) all.push(ts);

  const cache: Record<string, MakerWindow> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf8"))
    : {};
  const todo = all.filter((ts) => !cache[ts]);
  console.error(`windows: ${all.length} (${todo.length} to fetch)`);
  const fetched = await pool(todo, 6, loadMakerWindow);
  for (const w of fetched) if (w) cache[w.ts] = w;
  mkdirSync(resolve("data"), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));

  const windows = all.map((ts) => cache[ts]).filter((w): w is MakerWindow => w != null);
  const trades = windows.reduce((s, w) => s + w.tape.length, 0);
  const volume = windows.reduce((s, w) => s + w.tape.reduce((a, t) => a + t[4], 0), 0);
  console.error(`fetching Binance 1s/1m for ${days}d…`);
  const [sec, min] = await Promise.all([klines("1s", start - 10, end + 300), klines("1m", start - 3600, end + 300)]);
  console.log(
    `${windows.length} resolved windows over ${days}d · ${trades} taker trades · ${Math.round(volume).toLocaleString()} shares\n`,
  );

  const rows: (string | number)[][] = [];
  const combos: [Mode, number, number, number, number][] = [];
  for (const mode of modes)
    for (const inv of invLimits)
      for (const queue of queues)
        for (const lag of lags)
          for (const delta of deltas) combos.push([mode, inv, queue, lag, delta]);
  for (const [mode, inv, queue, lag, delta] of combos) {
    {
      const r = simulate(windows, sec, min, mode, delta, lag, queue, inv);
      const net = r.payout - r.cost + r.rebate;
      const n = r.perWindow.length;
      const mean = net / n;
      const sd = Math.sqrt(r.perWindow.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
      rows.push([
        mode,
        inv || "-",
        queue,
        lag,
        delta,
        Math.round(r.shares),
        r.shares ? f3(r.cost / r.shares) : "-",
        r.shares ? pct(r.payout / r.shares) : "-",
        r.shares ? f3((r.payout - r.cost) / r.shares) : "-",
        r.shares ? f3(r.rebate / r.shares) : "-",
        net.toFixed(2),
        f3(mean / (sd / Math.sqrt(n))),
        r.shares ? pct(r.skew / r.shares) : "-",
      ]);
    }
  }
  console.log(
    `Resting bids on both outcomes, requoted with L s delay, ${quoteSize} sh/s cap, stop ${stopBefore}s before close.\n` +
      "model: bid = fair − δ.  touch: bid = min(market best bid, fair − δ).  q = share of at-price flow we get.  inv = max UP/DOWN share imbalance.",
  );
  table(
    ["mode", "inv", "q", "L s", "δ", "shares", "avg bid", "won", "markout/sh", "rebate/sh", "net $", "t (per window)", "skew"],
    rows,
  );
  console.log(
    "markout/sh = payout − price per share filled (negative ⇒ adverse selection beats the spread).\n" +
      "skew = unmatched inventory share; high skew means the PnL is a directional bet, not spread capture.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
