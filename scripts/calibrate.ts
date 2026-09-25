import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  fetchOfficialOutcome,
  type OfficialOutcome,
} from "../src/adapters/polymarket/resolution.js";
import { takerFeePerShare } from "../src/policy.js";

/**
 * Join the Jev log with official Polymarket outcomes and ask: is Jev calibrated,
 * and does it beat the market's own price as a forecast?
 *
 * Usage: tsx scripts/calibrate.ts [jev-log.jsonl] [--min-seconds 90] [--fee-rate 0.07]
 */

type Quote = { bid: number | null; ask: number | null; mid: number };
type Row = {
  at: string;
  slug: string;
  secondsLeft: number | null;
  side: "UP" | "DOWN";
  confidence: number;
  pUp: number | null;
  pDown: number | null;
  up: Quote;
  down: Quote;
  movePct: number;
};

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

const logPath = resolve(
  process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : "data/jev-log.jsonl",
);
const cachePath = resolve(dirname(logPath), "outcomes.json");
const minSeconds = arg("--min-seconds", 90);
const feeRate = arg("--fee-rate", 0.07);

function slugEndMs(slug: string): number {
  const m = /-(\d+)$/.exec(slug);
  return m ? (Number(m[1]) + 300) * 1000 : Infinity;
}

async function outcomes(slugs: string[]): Promise<Map<string, OfficialOutcome>> {
  const cache: Record<string, OfficialOutcome> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf8"))
    : {};
  for (const slug of slugs) {
    if (cache[slug] || slugEndMs(slug) > Date.now()) continue;
    const o = await fetchOfficialOutcome(slug).catch(() => null);
    if (o) cache[slug] = o;
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  return new Map(Object.entries(cache));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const f3 = (x: number) => x.toFixed(3);

function table(head: string[], rows: (string | number)[][]): void {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r: (string | number)[]) => r.map((c, i) => String(c).padStart(w[i]!)).join("  ");
  console.log(line(head));
  for (const r of rows) console.log(line(r));
  console.log();
}

async function main(): Promise<void> {
  if (!existsSync(logPath)) throw new Error(`no Jev log at ${logPath} — run the bot first`);
  const rows: Row[] = readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => r.pUp != null);

  const resolved = await outcomes([...new Set(rows.map((r) => r.slug))]);
  const joined = rows
    .map((r) => ({ r, o: resolved.get(r.slug) }))
    .filter((x): x is { r: Row; o: OfficialOutcome } => x.o != null);
  const windows = new Set(joined.map((x) => x.r.slug));
  console.log(
    `${rows.length} Jev answers, ${joined.length} in ${windows.size} officially resolved windows\n`,
  );
  if (joined.length === 0) return;

  // 1) Forecast quality: Brier score (lower is better) of P(UP) vs outcome.
  //    Market forecast = UP mid. If Jev can't beat the mid, it adds no information.
  const buckets = [
    [240, 301],
    [180, 240],
    [120, 180],
    [60, 120],
    [0, 60],
  ] as const;
  const brierRows = buckets.map(([lo, hi]) => {
    const xs = joined.filter(
      (x) => x.r.secondsLeft != null && x.r.secondsLeft >= lo && x.r.secondsLeft < hi,
    );
    const y = (x: (typeof xs)[number]) => (x.o.winner === "UP" ? 1 : 0);
    const brier = (p: (x: (typeof xs)[number]) => number) =>
      xs.length ? xs.reduce((s, x) => s + (p(x) - y(x)) ** 2, 0) / xs.length : NaN;
    return [
      `${lo}-${Math.min(hi, 300)}s`,
      xs.length,
      f3(brier((x) => x.r.pUp!)),
      f3(brier((x) => x.r.up.mid)),
      f3(brier(() => 0.5)),
    ];
  });
  console.log("Brier score by seconds left (lower = better forecast)");
  table(["left", "n", "jev", "market", "coin"], brierRows);

  // 2) Reliability: when Jev says P(UP)=x, how often is it UP?
  const rel: (string | number)[][] = [];
  for (let b = 0; b < 10; b++) {
    const xs = joined.filter((x) => Math.min(9, Math.floor(x.r.pUp! * 10)) === b);
    if (!xs.length) continue;
    const mean = xs.reduce((s, x) => s + x.r.pUp!, 0) / xs.length;
    const hit = xs.filter((x) => x.o.winner === "UP").length / xs.length;
    rel.push([`${b / 10}-${(b + 1) / 10}`, xs.length, f3(mean), pct(hit)]);
  }
  console.log("Reliability of Jev P(UP) (calibrated ⇒ actual ≈ predicted)");
  table(["bucket", "n", "predicted", "actual UP"], rel);

  // 3) What the `confidence` field means: chosen side's win rate by confidence.
  const confRows: (string | number)[][] = [];
  for (const [lo, hi] of [[0, 0.5], [0.5, 0.8], [0.8, 0.9], [0.9, 0.95], [0.95, 1.01]] as const) {
    const xs = joined.filter((x) => x.r.confidence >= lo && x.r.confidence < hi);
    if (!xs.length) continue;
    const won = xs.filter((x) => x.o.winner === x.r.side).length / xs.length;
    confRows.push([`${lo}-${Math.min(hi, 1)}`, xs.length, pct(won)]);
  }
  console.log("Jev confidence vs how often its chosen side won");
  table(["confidence", "n", "side won"], confRows);

  // 4) Taker strategy sim: first tick per window (≥ minSeconds left) where
  //    P_jev(side) − ask − fee ≥ θ. One share per trade; PnL after fees.
  const simRows: (string | number)[][] = [];
  for (const theta of [0, 0.02, 0.05, 0.1, 0.15]) {
    const seen = new Set<string>();
    let n = 0, wins = 0, pnl = 0, askSum = 0;
    for (const { r, o } of joined) {
      if (seen.has(r.slug) || (r.secondsLeft ?? 0) < minSeconds) continue;
      for (const side of ["UP", "DOWN"] as const) {
        const q = side === "UP" ? r.up : r.down;
        const p = side === "UP" ? r.pUp! : 1 - r.pUp!;
        if (q.ask == null || q.ask <= 0 || q.ask >= 1) continue;
        const fee = takerFeePerShare(q.ask, feeRate);
        if (p - q.ask - fee < theta) continue;
        seen.add(r.slug);
        n++;
        askSum += q.ask;
        const win = o.winner === side;
        wins += win ? 1 : 0;
        pnl += (win ? 1 : 0) - q.ask - fee;
        break;
      }
    }
    simRows.push([
      theta,
      n,
      n ? pct(wins / n) : "-",
      n ? f3(askSum / n) : "-",
      pnl.toFixed(2),
      n ? f3(pnl / n) : "-",
    ]);
  }
  console.log(
    `Taker sim: buy 1 share when P_jev − ask − fee ≥ θ (first per window, ≥${minSeconds}s left)`,
  );
  table(["θ", "trades", "win", "avg ask", "net $", "$/trade"], simRows);
  console.log(
    "Read: an edge is real only if 'jev' beats 'market' in Brier and the sim stays positive\n" +
      "across θ over hundreds of windows. A few dozen trades is noise.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
