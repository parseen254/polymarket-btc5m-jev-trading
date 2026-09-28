import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv } from "../src/loadEnv.js";
import { takerFeePerShare } from "../src/policy.js";
import { arg, argList, f3, klines, pct, seconds, sigmaPerSecBefore, table, twapFairUp } from "./lib/history.js";

/**
 * Can BTC-side signals improve "TWAP + Jev" (≈ TWAP + side BTC is on: Jev's pick
 * equals that side 98.5 % of the time)? Each rule = base + one extra gate:
 *
 *   base      P_twap(side) − ask − fee ≥ θ, and side = the side BTC is on vs the open
 *   mom30/60  last 30/60 s return points the same way
 *   flow30/60 Binance taker-buy share (aggressive buyers vs sellers) points the same way
 *   trend15   15-minute return points the same way
 *   strong    |move| ≥ 0.5 σ of what's left (the model is already confident)
 *   lowvol/hivol  σ below/above its median over the in-sample period
 *   jev       real cached Jev answer agrees (only where data/jev-hist-cache.json has it)
 *
 * The last `--oos-days` are out-of-sample. Trust a gate only if it helps in both halves.
 *
 * Usage: tsx scripts/backtest-signals.ts [--days 9.9] [--oos-days 2.95] [--lag 2]
 *        [--thetas 0,0.05,0.1] [--spread 0.01]
 */

loadDotEnv();

const days = arg("--days", 9.9);
const oosDays = arg("--oos-days", 2.95);
const lag = arg("--lag", 2);
const thetas = argList("--thetas", [0, 0.05, 0.1]);
const halfSpread = arg("--spread", 0.01);
const feeRate = arg("--fee-rate", 0.07);

type Window = { ts: number; winner: "UP" | "DOWN"; upPath: { t: number; p: number }[] };
type Side = "UP" | "DOWN";
type Pt = {
  w: Window; t: number; mkt: number; pTwap: number; move: number; sigma: number; z: number;
  mom30: number; mom60: number; flow30: number; flow60: number; trend15: number; jev: number | null;
};

async function main(): Promise<void> {
  const cache: Record<string, Window> = JSON.parse(readFileSync(resolve("data/backtest-cache.json"), "utf8"));
  const jevPath = resolve("data/jev-hist-cache.json");
  const jevCache: Record<string, number> = existsSync(jevPath) ? JSON.parse(readFileSync(jevPath, "utf8")) : {};
  const end = Math.floor(Date.now() / 1000 / 300) * 300 - 600;
  const start = end - Math.round((days * 86_400) / 300) * 300;
  const split = end - Math.round((oosDays * 86_400) / 300) * 300;
  const windows: Window[] = [];
  for (let ts = start; ts < end; ts += 300) if (cache[ts]?.upPath.length) windows.push(cache[ts]!);
  console.error(`${windows.length} cached windows (run \`npm run backtest -- --days ${days}\` to fill gaps); fetching Binance 1s…`);

  const [s, min] = await Promise.all([seconds(start - 1000, end + 300), klines("1m", start - 3600, end + 300)]);

  const pts: Pt[] = [];
  for (const w of windows) {
    const k = s.avg(w.ts - 60, w.ts);
    const open = s.at(w.ts);
    const sigma = sigmaPerSecBefore(min, w.ts);
    if (!Number.isFinite(k) || !open || sigma == null) continue;
    for (const h of w.upPath) {
      if (w.ts + 300 - h.t < 90) continue;
      const ti = h.t - lag;
      const st = s.at(ti), s30 = s.at(ti - 30), s60 = s.at(ti - 60), s900 = s.at(ti - 900);
      if (!st || !s30 || !s60 || !s900) continue;
      const tau = w.ts + 300 - ti;
      pts.push({
        w, t: h.t, mkt: h.p, sigma,
        pTwap: twapFairUp({ st, k, sigmaPerSec: sigma, tau, partial: tau < 60 ? s.avg(w.ts + 240, ti + 1) : null }),
        move: Math.log(st / open),
        z: Math.abs(Math.log(st / k)) / (sigma * Math.sqrt(tau)),
        mom30: Math.log(st / s30), mom60: Math.log(st / s60), trend15: Math.log(st / s900),
        flow30: s.flow(ti - 30, ti), flow60: s.flow(ti - 60, ti),
        jev: jevCache[`${w.ts}:${h.t}:${lag}`] ?? null,
      });
    }
  }
  const isSig = pts.filter((p) => p.w.ts < split).map((p) => p.sigma).sort((a, b) => a - b);
  const medSigma = isSig[isSig.length >> 1] ?? 0;

  const dir = (side: Side) => (side === "UP" ? 1 : -1);
  const gates: [string, (p: Pt, side: Side) => boolean][] = [
    ["base", () => true],
    ["jev", (p, side) => p.jev != null && (side === "UP" ? p.jev : 1 - p.jev) >= 0.5],
    ["mom30", (p, side) => dir(side) * p.mom30 > 0],
    ["mom60", (p, side) => dir(side) * p.mom60 > 0],
    ["flow30", (p, side) => dir(side) * p.flow30 > 0],
    ["flow60", (p, side) => dir(side) * p.flow60 > 0],
    ["mom30+flow30", (p, side) => dir(side) * p.mom30 > 0 && dir(side) * p.flow30 > 0],
    ["trend15", (p, side) => dir(side) * p.trend15 > 0],
    ["strong", (p) => p.z >= 0.5],
    ["lowvol", (p) => p.sigma <= medSigma],
    ["hivol", (p) => p.sigma > medSigma],
  ];

  const run = (subset: Pt[], gate: (p: Pt, side: Side) => boolean, theta: number) => {
    const seen = new Set<number>();
    let n = 0, wins = 0, pnl = 0, pnl2 = 0;
    for (const p of subset) {
      if (seen.has(p.w.ts)) continue;
      const side: Side = p.move >= 0 ? "UP" : "DOWN";
      const ask = (side === "UP" ? p.mkt : 1 - p.mkt) + halfSpread;
      if (ask <= 0 || ask >= 1) continue;
      const fee = takerFeePerShare(ask, feeRate);
      const prob = side === "UP" ? p.pTwap : 1 - p.pTwap;
      if (prob - ask - fee < theta || !gate(p, side)) continue;
      seen.add(p.w.ts);
      const win = p.w.winner === side;
      const r = (win ? 1 : 0) - ask - fee;
      n++; wins += win ? 1 : 0; pnl += r; pnl2 += r * r;
    }
    const mean = n ? pnl / n : NaN;
    const sd = n > 1 ? Math.sqrt((pnl2 - n * mean * mean) / (n - 1)) : NaN;
    return { n, win: n ? wins / n : NaN, mean, t: mean / (sd / Math.sqrt(n)) };
  };

  const inS = pts.filter((p) => p.w.ts < split);
  const outS = pts.filter((p) => p.w.ts >= split);
  const nIn = new Set(inS.map((p) => p.w.ts)).size, nOut = new Set(outS.map((p) => p.w.ts)).size;
  console.log(
    `In-sample ${nIn} windows (to ${new Date(split * 1000).toISOString().slice(0, 16)}Z) · out-of-sample ${nOut} windows · data delay ${lag}s\n`,
  );
  const rows: (string | number)[][] = [];
  for (const theta of thetas) {
    for (const [name, gate] of gates) {
      const a = run(inS, gate, theta), b = run(outS, gate, theta);
      rows.push([
        theta, name,
        a.n, a.n ? pct(a.win) : "-", a.n ? f3(a.mean) : "-", a.n > 1 ? f3(a.t) : "-",
        b.n, b.n ? pct(b.win) : "-", b.n ? f3(b.mean) : "-", b.n > 1 ? f3(b.t) : "-",
      ]);
    }
  }
  console.log(`Taker sim: 1 share at price + ${halfSpread}, fee rate ${feeRate}, first qualifying point per window, ≥90 s left`);
  table(["θ", "rule", "IS n", "IS win", "IS $/tr", "IS t", "OOS n", "OOS win", "OOS $/tr", "OOS t"], rows);
  console.log("'jev' only has answers for the out-of-sample period (from backtest:combo).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
