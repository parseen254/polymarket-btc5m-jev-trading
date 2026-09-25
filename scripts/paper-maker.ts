import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fetchOfficialOutcome } from "../src/adapters/polymarket/resolution.js";
import { loadDotEnv } from "../src/loadEnv.js";
import {
  arg,
  argList,
  f3,
  klines,
  pct,
  sigmaPerSecBefore,
  table,
  twapFairUp,
} from "./lib/history.js";

/**
 * Paper market maker replayed on a recorded L2 book (scripts/record-book.ts).
 *
 * Every `--requote` ms the maker decides a bid for UP and for DOWN:
 *   bid_X = min(best bid_X, fair_X − δ), kept below best ask (post-only),
 *   skipped when X already leads the other side by `--inv` shares.
 * fair uses the TWAP settlement model on Binance mids seen `infoLag` ms ago.
 * New/cancelled orders take effect `orderLag` ms after the decision; until then the
 * old order can still be hit.
 *
 * Queue model (pessimistic): a new order joins the back of its level. Only trades at
 * that price move it forward; cancellations are assumed to come from behind it. A
 * taker who sells through our price (trade below our bid) fills us first.
 * A taker buy of the other outcome at p is a sell of this one at 1 − p only if our
 * bid was strictly better (it may have matched that outcome's asks, not our queue).
 *
 * Usage: tsx scripts/paper-maker.ts [--info-lags 0,250,1000,2000] [--order-lags 100,500]
 *        [--deltas 0.02,0.03,0.05] [--inv 20] [--size 10] [--requote 250] [--stop 20]
 */

loadDotEnv();

const infoLags = argList("--info-lags", [0, 250, 1000, 2000]);
const orderLags = argList("--order-lags", [100, 500]);
const deltas = argList("--deltas", [0.02, 0.03, 0.05]);
const invLimit = arg("--inv", 20);
const quoteSize = arg("--size", 10);
const requoteMs = arg("--requote", 250);
const stopBefore = arg("--stop", 20);
const rebateRate = arg("--rebate-rate", 0.2);
const feeRate = arg("--fee-rate", 0.07);

type Ev =
  | { k: "w"; t: number; slug: string; ts: number; up: string; down: string }
  | { k: "b"; t: number; a: string; bids: [number, number][]; asks: [number, number][] }
  | { k: "p"; t: number; a: string; p: number; s: number; side: "BUY" | "SELL" }
  | { k: "x"; t: number; a: string; p: number; s: number; side: "BUY" | "SELL"; st: number }
  | { k: "n"; t: number; bid: number; ask: number }
  | { k: "c"; t: number; v: number; st: number };

const round2 = (x: number) => Math.round(x * 100) / 100;

function loadEvents(): Ev[] {
  const dir = resolve("data/book");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz")).sort();
  const out: Ev[] = [];
  for (const f of files) {
    const text = gunzipSync(readFileSync(resolve(dir, f))).toString("utf8");
    for (const line of text.split("\n")) if (line) out.push(JSON.parse(line) as Ev);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Binance mid as a step function; value and time-weighted average lookups. */
function midSeries(events: Ev[]) {
  const ts: number[] = [];
  const vs: number[] = [];
  for (const e of events) if (e.k === "n") { ts.push(e.t); vs.push((e.bid + e.ask) / 2); }
  const at = (t: number): number | null => {
    let lo = 0, hi = ts.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m]! <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? null : vs[ans]!;
  };
  const avg = (a: number, b: number): number | null => {
    if (b <= a || at(a) == null) return null;
    let sum = 0, cur = a, v = at(a)!;
    let i = ts.findIndex((x) => x > a);
    if (i < 0) i = ts.length;
    while (i < ts.length && ts[i]! < b) { sum += v * (ts[i]! - cur); cur = ts[i]!; v = vs[i]!; i++; }
    sum += v * (b - cur);
    return sum / (b - a);
  };
  return { at, avg, first: ts[0] ?? Infinity };
}

type Side = "UP" | "DOWN";
/** ahead < 0 until the order goes live; then it's set to the level's size at that moment. */
type Order = { price: number; ahead: number; left: number; liveAt: number; deadAt: number };

type WindowResult = { slug: string; held: Record<Side, number>; cost: number; rebate: number; fills: number };

function simulate(
  events: Ev[],
  windows: Map<string, { ts: number; up: string; down: string }>,
  mids: ReturnType<typeof midSeries>,
  sigmaFor: (ts: number) => number | null,
  infoLag: number,
  orderLag: number,
  delta: number,
): WindowResult[] {
  const assetInfo = new Map<string, { slug: string; side: Side; other: string }>();
  for (const [slug, w] of windows) {
    assetInfo.set(w.up, { slug, side: "UP", other: w.down });
    assetInfo.set(w.down, { slug, side: "DOWN", other: w.up });
  }
  const books = new Map<string, { bids: Map<number, number>; asks: Map<number, number> }>();
  const book = (a: string) => {
    let b = books.get(a);
    if (!b) books.set(a, (b = { bids: new Map(), asks: new Map() }));
    return b;
  };
  const best = (m: Map<number, number>, hi: boolean) => {
    let x: number | null = null;
    for (const [p, s] of m) if (s > 0 && (x == null || (hi ? p > x : p < x))) x = p;
    return x;
  };

  const results = new Map<string, WindowResult>();
  // Per asset: orders (current + possibly a pending replacement during orderLag).
  const orders = new Map<string, Order[]>();
  let nextDecision = 0;

  const activate = (asset: string, t: number) => {
    for (const o of orders.get(asset) ?? []) {
      if (o.ahead < 0 && t >= o.liveAt) o.ahead = book(asset).bids.get(o.price) ?? 0;
    }
  };

  const fill = (asset: string, price: number, size: number, t: number, atLevel: boolean) => {
    const info = assetInfo.get(asset);
    if (!info) return;
    const r = results.get(info.slug);
    if (!r) return;
    activate(asset, t);
    for (const o of orders.get(asset) ?? []) {
      if (t < o.liveAt || t >= o.deadAt || o.left <= 0) continue;
      let q = 0;
      if (price < o.price - 1e-9) {
        q = Math.min(o.left, size); // taker sold below us → we were hit first
      } else if (atLevel && Math.abs(price - o.price) < 1e-9) {
        const beyond = size - o.ahead;
        o.ahead = Math.max(0, o.ahead - size);
        q = Math.min(o.left, Math.max(0, beyond));
      }
      if (q <= 0) continue;
      o.left -= q;
      size -= q;
      r.held[info.side] += q;
      r.cost += q * o.price;
      r.rebate += q * rebateRate * feeRate * o.price * (1 - o.price);
      r.fills++;
    }
  };

  const decide = (t: number) => {
    for (const [slug, w] of windows) {
      const end = (w.ts + 300) * 1000;
      if (t < w.ts * 1000 || t >= end) continue;
      if (!results.has(slug)) results.set(slug, { slug, held: { UP: 0, DOWN: 0 }, cost: 0, rebate: 0, fills: 0 });
      const r = results.get(slug)!;
      const tInfo = t - infoLag;
      const k = mids.avg(w.ts * 1000 - 60_000, w.ts * 1000);
      const st = mids.at(tInfo);
      const sigma = sigmaFor(w.ts);
      const stopQuoting = t >= end - stopBefore * 1000;
      let fair: number | null = null;
      if (k != null && st != null && sigma != null && mids.first < w.ts * 1000 - 60_000) {
        const tau = (end - tInfo) / 1000;
        fair = twapFairUp({
          st,
          k,
          sigmaPerSec: sigma,
          tau,
          partial: tau < 60 ? mids.avg(end - 60_000, tInfo) : null,
        });
      }
      for (const [asset, side] of [[w.up, "UP"], [w.down, "DOWN"]] as const) {
        const other = side === "UP" ? "DOWN" : "UP";
        const list = (orders.get(asset) ?? []).filter((o) => o.deadAt > t && o.left > 0);
        orders.set(asset, list);
        const current = list.find((o) => o.deadAt === Infinity);
        let target: number | null = null;
        if (fair != null && !stopQuoting && r.held[side] - r.held[other] < invLimit) {
          const b = book(asset);
          const bb = best(b.bids, true);
          const ba = best(b.asks, false);
          const fairSide = side === "UP" ? fair : 1 - fair;
          let p = Math.floor((fairSide - delta) * 100 + 1e-9) / 100;
          if (bb != null) p = Math.min(p, bb);
          if (ba != null) p = Math.min(p, round2(ba - 0.01));
          if (p >= 0.01 && p <= 0.99) target = round2(p);
        }
        if (current && target != null && Math.abs(current.price - target) < 1e-9) continue;
        if (current) current.deadAt = t + orderLag; // cancel lands after orderLag
        if (target != null) {
          list.push({ price: target, ahead: -1, left: quoteSize, liveAt: t + orderLag, deadAt: Infinity });
        }
      }
    }
  };

  nextDecision = events[0]?.t ?? 0;
  for (const e of events) {
    while (nextDecision <= e.t) {
      decide(nextDecision);
      nextDecision += requoteMs;
    }
    if (e.k === "w") {
      if (!windows.has(e.slug)) continue;
    } else if (e.k === "b") {
      const b = book(e.a);
      b.bids = new Map(e.bids);
      b.asks = new Map(e.asks);
    } else if (e.k === "p") {
      activate(e.a, e.t);
      const b = book(e.a);
      (e.side === "BUY" ? b.bids : b.asks).set(e.p, e.s);
      // A level we rest on that empties means everyone ahead left: we're at the front.
      if (e.side === "BUY" && e.s === 0) for (const o of orders.get(e.a) ?? []) if (Math.abs(o.price - e.p) < 1e-9) o.ahead = 0;
    } else if (e.k === "x") {
      const info = assetInfo.get(e.a);
      if (!info) continue;
      if (e.side === "SELL") fill(e.a, e.p, e.s, e.t, true);
      else fill(info.other, round2(1 - e.p), e.s, e.t, false);
    }
  }
  return [...results.values()];
}

async function main(): Promise<void> {
  const events = loadEvents();
  if (!events.length) throw new Error("no recordings in data/book — run scripts/record-book.ts first");
  const windows = new Map<string, { ts: number; up: string; down: string }>();
  for (const e of events) if (e.k === "w") windows.set(e.slug, { ts: e.ts, up: e.up, down: e.down });

  // Official outcomes (cached) and 1m vol.
  const cachePath = resolve("data/outcomes.json");
  const cache: Record<string, { winner: Side }> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  for (const slug of windows.keys()) {
    if (!cache[slug]) {
      const o = await fetchOfficialOutcome(slug).catch(() => null);
      if (o) cache[slug] = o;
    }
  }
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  const tsList = [...windows.values()].map((w) => w.ts);
  const min = await klines("1m", Math.min(...tsList) - 3600, Math.max(...tsList) + 300);
  const mids = midSeries(events);
  const first = events[0]!.t, last = events.at(-1)!.t;
  // Only windows fully inside the recording (incl. the minute before start), and resolved.
  for (const [slug, w] of windows) {
    if (w.ts * 1000 - 60_000 < first || (w.ts + 300) * 1000 > last || !cache[slug]) windows.delete(slug);
  }
  console.log(
    `${events.length.toLocaleString()} events · ${((last - first) / 60000).toFixed(0)} min recorded · ${windows.size} complete resolved windows\n`,
  );
  if (!windows.size) return;

  const rows: (string | number)[][] = [];
  for (const orderLag of orderLags) {
    for (const infoLag of infoLags) {
      for (const delta of deltas) {
        const res = simulate(events, windows, mids, (ts) => sigmaPerSecBefore(min, ts), infoLag, orderLag, delta);
        let shares = 0, cost = 0, payout = 0, rebate = 0, skew = 0, fills = 0;
        const per: number[] = [];
        for (const r of res) {
          const win = cache[r.slug]!.winner;
          const sh = r.held.UP + r.held.DOWN;
          shares += sh; cost += r.cost; payout += r.held[win]; rebate += r.rebate; fills += r.fills;
          skew += Math.abs(r.held.UP - r.held.DOWN);
          per.push(r.held[win] - r.cost + r.rebate);
        }
        const net = payout - cost + rebate;
        const n = per.length, mean = net / n;
        const sd = Math.sqrt(per.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
        rows.push([
          orderLag, infoLag, delta, fills, Math.round(shares),
          shares ? f3(cost / shares) : "-", shares ? pct(payout / shares) : "-",
          shares ? f3((payout - cost) / shares) : "-", shares ? f3(rebate / shares) : "-",
          net.toFixed(2), n > 1 ? f3(mean / (sd / Math.sqrt(n))) : "-", shares ? pct(skew / shares) : "-",
        ]);
      }
    }
  }
  console.log(
    `Touch maker on the real book: bid = min(best bid, fair − δ), ${quoteSize} sh, inv ${invLimit}, requote ${requoteMs} ms, stop ${stopBefore}s before close.\n` +
      "Queue: back of level, advances only on trades at our price (cancels assumed behind us).",
  );
  table(
    ["order ms", "info ms", "δ", "fills", "shares", "avg bid", "won", "markout/sh", "rebate/sh", "net $", "t (per window)", "skew"],
    rows,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
