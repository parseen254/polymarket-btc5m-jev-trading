import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { fetchOfficialOutcome } from "../src/adapters/polymarket/resolution.js";
import { loadDotEnv } from "../src/loadEnv.js";
import { takerFeePerShare } from "../src/policy.js";
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
 * Replay recorded L2 books (scripts/record-book.ts) through two paper strategies,
 * both priced with the TWAP settlement model on Binance mids seen `infoLag` ms ago.
 *
 * MAKER — every `--requote` ms, bid for UP and DOWN at min(best bid, fair − δ), kept
 *   below the best ask, skipped when that side leads the other by `--inv` shares.
 *   Orders go live, and cancels land, `orderLag` ms after the decision; until then
 *   the old order can still be hit. Queue (pessimistic): join the back of the level
 *   when live; advance only on trades at our price (cancels assumed behind us); a
 *   level that empties puts us at the front. A taker selling below our price fills
 *   us first. A taker buying the other outcome at p counts as a sell of ours at
 *   1 − p only if our bid was strictly better (it may have matched their asks).
 *
 * TAKER — once per window with ≥ 90 s left, buy at the real best ask when
 *   fair − ask − fee ≥ θ (size ≤ ask size, cap `--size`), and hold to resolution.
 *
 * Usage: tsx scripts/paper-maker.ts [--info-lags 0,1000,2000,5000] [--order-lags 100,500]
 *        [--deltas 0.02,0.03,0.05] [--thetas 0,0.05,0.1] [--inv 20] [--size 10]
 *        [--requote 250] [--stop 20]
 */

loadDotEnv();

const infoLags = argList("--info-lags", [0, 1000, 2000, 5000]);
const orderLags = argList("--order-lags", [100, 500]);
const deltas = argList("--deltas", [0.02, 0.03, 0.05]);
const thetas = argList("--thetas", [0, 0.05, 0.1]);
const invLimit = arg("--inv", 20);
const quoteSize = arg("--size", 10);
const requoteMs = arg("--requote", 250);
const stopBefore = arg("--stop", 20);
const rebateRate = arg("--rebate-rate", 0.2);
const feeRate = arg("--fee-rate", 0.07);

type Side = "UP" | "DOWN";
type Ev =
  | { k: "w"; t: number; slug: string; ts: number; up: string; down: string }
  | { k: "b"; t: number; a: string; bids: [number, number][]; asks: [number, number][] }
  | { k: "p"; t: number; a: string; p: number; s: number; side: "BUY" | "SELL" }
  | { k: "x"; t: number; a: string; p: number; s: number; side: "BUY" | "SELL"; st: number }
  | { k: "n"; t: number; bid: number; ask: number }
  | { k: "c"; t: number; v: number; st: number };
type Win = { slug: string; ts: number; up: string; down: string };

const round2 = (x: number) => Math.round(x * 100) / 100;
const files = () => {
  const dir = resolve("data/book");
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz")).sort().map((f) => resolve(dir, f));
};
async function* lines(): AsyncGenerator<string> {
  for (const f of files()) {
    const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) if (line) yield line;
  }
}

/** Shared market state, built incrementally so lookups only ever see the past. */
class Market {
  books = new Map<string, { bids: Map<number, number>; asks: Map<number, number> }>();
  midT: number[] = [];
  midV: number[] = [];
  book(a: string) {
    let b = this.books.get(a);
    if (!b) this.books.set(a, (b = { bids: new Map(), asks: new Map() }));
    return b;
  }
  best(a: string, side: "bid" | "ask"): { p: number; s: number } | null {
    const m = side === "bid" ? this.book(a).bids : this.book(a).asks;
    let x: { p: number; s: number } | null = null;
    for (const [p, s] of m) if (s > 0 && (x == null || (side === "bid" ? p > x.p : p < x.p))) x = { p, s };
    return x;
  }
  private idx(t: number): number {
    let lo = 0, hi = this.midT.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.midT[m]! <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  midAt(t: number): number | null {
    const i = this.idx(t);
    return i < 0 ? null : this.midV[i]!;
  }
  /** Time-weighted mean of the mid over [a, b). */
  midAvg(a: number, b: number): number | null {
    let i = this.idx(a);
    if (i < 0 || b <= a) return null;
    let sum = 0, cur = a, v = this.midV[i]!;
    for (i = i + 1; i < this.midT.length && this.midT[i]! < b; i++) {
      sum += v * (this.midT[i]! - cur);
      cur = this.midT[i]!;
      v = this.midV[i]!;
    }
    return (sum + v * (b - cur)) / (b - a);
  }
}

type Fill = { side: Side; q: number; price: number; through: boolean };
type Book = { held: Record<Side, number>; cost: number; rebate: number; fee: number; fills: Fill[] };
const emptyBook = (): Book => ({ held: { UP: 0, DOWN: 0 }, cost: 0, rebate: 0, fee: 0, fills: [] });

/** Fair P(UP) for window w at decision time t, using info from t − infoLag. */
function fairAt(m: Market, w: Win, t: number, infoLag: number, sigma: number | null): number | null {
  const start = w.ts * 1000, end = start + 300_000;
  const tInfo = t - infoLag;
  const k = m.midAvg(start - 60_000, start);
  const st = m.midAt(tInfo);
  if (k == null || st == null || sigma == null || m.midT[0]! > start - 60_000) return null;
  const tau = (end - tInfo) / 1000;
  return twapFairUp({ st, k, sigmaPerSec: sigma, tau, partial: tau < 60 ? m.midAvg(end - 60_000, tInfo) : null });
}

type Order = { price: number; ahead: number; left: number; liveAt: number; deadAt: number };

class MakerSim {
  results = new Map<string, Book>();
  orders = new Map<string, Order[]>();
  constructor(
    readonly m: Market,
    readonly assets: Map<string, { w: Win; side: Side; other: string }>,
    readonly sigma: (ts: number) => number | null,
    readonly infoLag: number,
    readonly orderLag: number,
    readonly delta: number,
  ) {}

  private activate(asset: string, t: number) {
    for (const o of this.orders.get(asset) ?? []) {
      if (o.ahead < 0 && t >= o.liveAt) o.ahead = this.m.book(asset).bids.get(o.price) ?? 0;
    }
  }

  decide(t: number, active: Win[]) {
    for (const w of active) {
      const end = (w.ts + 300) * 1000;
      let r = this.results.get(w.slug);
      if (!r) this.results.set(w.slug, (r = emptyBook()));
      const fair = fairAt(this.m, w, t, this.infoLag, this.sigma(w.ts));
      const stop = t >= end - stopBefore * 1000;
      for (const [asset, side] of [[w.up, "UP"], [w.down, "DOWN"]] as const) {
        const other: Side = side === "UP" ? "DOWN" : "UP";
        const list = (this.orders.get(asset) ?? []).filter((o) => o.deadAt > t && o.left > 0);
        this.orders.set(asset, list);
        const current = list.find((o) => o.deadAt === Infinity);
        let target: number | null = null;
        if (fair != null && !stop && r.held[side] - r.held[other] < invLimit) {
          const fairSide = side === "UP" ? fair : 1 - fair;
          let p = Math.floor((fairSide - this.delta) * 100 + 1e-9) / 100;
          const bb = this.m.best(asset, "bid");
          const ba = this.m.best(asset, "ask");
          if (bb) p = Math.min(p, bb.p);
          if (ba) p = Math.min(p, round2(ba.p - 0.01));
          if (p >= 0.01 && p <= 0.99) target = round2(p);
        }
        if (current && target != null && Math.abs(current.price - target) < 1e-9) continue;
        if (current) current.deadAt = t + this.orderLag;
        if (target != null) list.push({ price: target, ahead: -1, left: quoteSize, liveAt: t + this.orderLag, deadAt: Infinity });
      }
    }
  }

  beforeLevel(e: Extract<Ev, { k: "p" }>) {
    this.activate(e.a, e.t);
    if (e.side === "BUY" && e.s === 0) {
      for (const o of this.orders.get(e.a) ?? []) if (Math.abs(o.price - e.p) < 1e-9 && o.ahead > 0) o.ahead = 0;
    }
  }

  trade(asset: string, price: number, size: number, t: number, atLevel: boolean) {
    const info = this.assets.get(asset);
    const r = info && this.results.get(info.w.slug);
    if (!info || !r) return;
    this.activate(asset, t);
    for (const o of this.orders.get(asset) ?? []) {
      if (t < o.liveAt || t >= o.deadAt || o.left <= 0 || size <= 0) continue;
      let q = 0;
      const through = price < o.price - 1e-9;
      if (through) q = Math.min(o.left, size);
      else if (atLevel && Math.abs(price - o.price) < 1e-9) {
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
      r.fills.push({ side: info.side, q, price: o.price, through });
    }
  }
}

class TakerSim {
  results = new Map<string, Book>();
  constructor(
    readonly m: Market,
    readonly sigma: (ts: number) => number | null,
    readonly infoLag: number,
    readonly theta: number,
  ) {}
  decide(t: number, active: Win[]) {
    for (const w of active) {
      if (this.results.has(w.slug)) continue;
      const end = (w.ts + 300) * 1000;
      if (end - t < 90_000) continue;
      const fair = fairAt(this.m, w, t, this.infoLag, this.sigma(w.ts));
      if (fair == null) continue;
      for (const [asset, side] of [[w.up, "UP"], [w.down, "DOWN"]] as const) {
        const ask = this.m.best(asset, "ask");
        if (!ask || ask.p <= 0 || ask.p >= 1) continue;
        const fee = takerFeePerShare(ask.p, feeRate);
        const p = side === "UP" ? fair : 1 - fair;
        if (p - ask.p - fee < this.theta) continue;
        const q = Math.min(quoteSize, ask.s);
        const r = emptyBook();
        r.held[side] = q;
        r.cost = q * ask.p;
        r.fee = q * fee;
        this.results.set(w.slug, r);
        break;
      }
    }
  }
}

function summarize(results: Map<string, Book>, outcomes: Record<string, { winner: Side }>, windows: Win[]) {
  let shares = 0, cost = 0, payout = 0, extra = 0, skew = 0, traded = 0;
  const per: number[] = [];
  for (const w of windows) {
    const r = results.get(w.slug);
    const win = outcomes[w.slug]!.winner;
    if (!r || r.held.UP + r.held.DOWN === 0) { per.push(0); continue; }
    traded++;
    shares += r.held.UP + r.held.DOWN;
    cost += r.cost;
    payout += r.held[win];
    extra += r.rebate - r.fee;
    skew += Math.abs(r.held.UP - r.held.DOWN);
    per.push(r.held[win] - r.cost + r.rebate - r.fee);
  }
  const net = payout - cost + extra;
  const n = per.length, mean = net / n;
  const sd = Math.sqrt(per.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  return { traded, shares, cost, payout, extra, net, skew, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : NaN };
}

async function main(): Promise<void> {
  if (!files().length) throw new Error("no recordings in data/book — run scripts/record-book.ts first");

  // Pass 1: windows and time span (cheap: only parse window lines).
  const all = new Map<string, Win>();
  let first = Infinity, last = -Infinity;
  for await (const line of lines()) {
    const t = Number(/"t":(\d+)/.exec(line)?.[1]);
    if (t < first) first = t;
    if (t > last) last = t;
    if (line.startsWith('{"k":"w"')) { const e = JSON.parse(line) as Win; all.set(e.slug, e); }
  }
  const cachePath = resolve("data/outcomes.json");
  const outcomes: Record<string, { winner: Side }> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  for (const slug of all.keys()) if (!outcomes[slug]) {
    const o = await fetchOfficialOutcome(slug).catch(() => null);
    if (o) outcomes[slug] = o;
  }
  writeFileSync(cachePath, JSON.stringify(outcomes, null, 1));
  const windows = [...all.values()].filter(
    (w) => w.ts * 1000 - 60_000 >= first && (w.ts + 300) * 1000 <= last && outcomes[w.slug],
  );
  console.log(`${((last - first) / 60000).toFixed(0)} min recorded · ${windows.length} complete resolved windows`);
  if (!windows.length) return;

  const tsList = windows.map((w) => w.ts);
  const min = await klines("1m", Math.min(...tsList) - 3600, Math.max(...tsList) + 300);
  const sigmaCache = new Map<number, number | null>();
  const sigma = (ts: number) => {
    if (!sigmaCache.has(ts)) sigmaCache.set(ts, sigmaPerSecBefore(min, ts));
    return sigmaCache.get(ts)!;
  };

  const m = new Market();
  const assets = new Map<string, { w: Win; side: Side; other: string }>();
  for (const w of windows) {
    assets.set(w.up, { w, side: "UP", other: w.down });
    assets.set(w.down, { w, side: "DOWN", other: w.up });
  }
  const makers: MakerSim[] = [];
  for (const orderLag of orderLags) for (const infoLag of infoLags) for (const d of deltas)
    makers.push(new MakerSim(m, assets, sigma, infoLag, orderLag, d));
  const takers: TakerSim[] = [];
  for (const infoLag of infoLags) for (const th of thetas) takers.push(new TakerSim(m, sigma, infoLag, th));

  // Pass 2: replay.
  let next = first;
  let n = 0;
  for await (const line of lines()) {
    const e = JSON.parse(line) as Ev;
    while (next <= e.t) {
      const active = windows.filter((w) => next >= w.ts * 1000 && next < (w.ts + 300) * 1000);
      if (active.length) {
        for (const s of makers) s.decide(next, active);
        for (const s of takers) s.decide(next, active);
      }
      next += requoteMs;
    }
    if (e.k === "n") {
      m.midT.push(e.t);
      m.midV.push((e.bid + e.ask) / 2);
    } else if (e.k === "b") {
      const b = m.book(e.a);
      b.bids = new Map(e.bids);
      b.asks = new Map(e.asks);
    } else if (e.k === "p") {
      if (assets.has(e.a)) for (const s of makers) s.beforeLevel(e);
      const b = m.book(e.a);
      (e.side === "BUY" ? b.bids : b.asks).set(e.p, e.s);
    } else if (e.k === "x") {
      const info = assets.get(e.a);
      if (info) for (const s of makers) {
        if (e.side === "SELL") s.trade(e.a, e.p, e.s, e.t, true);
        else s.trade(info.other, round2(1 - e.p), e.s, e.t, false);
      }
    }
    if (++n % 1_000_000 === 0) console.error(`replayed ${n.toLocaleString()} events`);
  }

  const mRows = makers.map((s) => {
    const r = summarize(s.results, outcomes, windows);
    return [
      s.orderLag, s.infoLag, s.delta, r.traded, Math.round(r.shares),
      r.shares ? f3(r.cost / r.shares) : "-", r.shares ? pct(r.payout / r.shares) : "-",
      r.shares ? f3((r.payout - r.cost) / r.shares) : "-", r.shares ? f3(r.extra / r.shares) : "-",
      r.net.toFixed(2), f3(r.t), r.shares ? pct(r.skew / r.shares) : "-",
    ];
  });
  console.log(
    `\nMAKER on the real book: bid = min(best bid, fair − δ), ${quoteSize} sh, inv ${invLimit}, requote ${requoteMs} ms, stop ${stopBefore}s before close.`,
  );
  table(["order ms", "info ms", "δ", "windows", "shares", "avg bid", "won", "markout/sh", "rebate/sh", "net $", "t", "skew"], mRows);

  const tRows = takers.map((s) => {
    const r = summarize(s.results, outcomes, windows);
    return [
      s.infoLag, s.theta, r.traded, r.shares ? f3(r.cost / r.shares) : "-", r.shares ? pct(r.payout / r.shares) : "-",
      r.shares ? f3((r.payout - r.cost + r.extra) / r.shares) : "-", r.net.toFixed(2), f3(r.t),
    ];
  });
  // Where maker fills come from: picked off (a seller went below our bid) vs queue at our price.
  const bRows: (string | number)[][] = [];
  for (const s of makers) {
    const agg = { through: { q: 0, mk: 0 }, level: { q: 0, mk: 0 } };
    for (const [slug, r] of s.results) {
      const win = outcomes[slug]?.winner;
      if (!win) continue;
      for (const f of r.fills) {
        const a = f.through ? agg.through : agg.level;
        a.q += f.q;
        a.mk += f.q * ((f.side === win ? 1 : 0) - f.price);
      }
    }
    bRows.push([
      s.orderLag, s.infoLag, s.delta,
      Math.round(agg.through.q), agg.through.q ? f3(agg.through.mk / agg.through.q) : "-",
      Math.round(agg.level.q), agg.level.q ? f3(agg.level.mk / agg.level.q) : "-",
    ]);
  }
  console.log("Maker fills by type: 'picked off' = a seller went below our bid; 'queue' = filled at our price in turn.");
  table(["order ms", "info ms", "δ", "picked off sh", "markout", "queue sh", "markout"], bRows);

  console.log(`TAKER at the real best ask, ≤${quoteSize} sh, once per window, ≥90 s left, fee included.`);
  table(["info ms", "θ", "trades", "avg ask", "won", "net/sh", "net $", "t"], tRows);
  console.log(`${windows.length} windows is a small sample: treat t-stats as a sanity check against the tape backtests, not proof.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
