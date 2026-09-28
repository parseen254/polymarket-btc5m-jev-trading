import { fetchJson } from "../../src/adapters/polymarket/wire.js";

export { TWAP_SEC, fairUp, phi, sigmaPerSecBefore, twapFairUp } from "../../src/model/twap.js";

/** Shared helpers for the history backtests. */

export function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

export function argList(name: string, fallback: number[]): number[] {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return String(process.argv[i + 1] ?? "")
    .split(",")
    .map(Number)
    .filter(Number.isFinite);
}

export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

export function binanceBase(): string {
  return (process.env.BINANCE_BASE_URL || "https://api.binance.com").replace(/\/+$/, "");
}

/** fetchJson with retries; long backtests make hundreds of requests and one flake shouldn't abort them. */
export async function fetchJsonRetry(url: string, attempts = 4): Promise<unknown> {
  for (let i = 1; ; i++) {
    try {
      return await fetchJson(url);
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    }
  }
}

/** Binance BTCUSDT klines → map openTimeSec → open. */
export async function klines(
  interval: "1s" | "1m",
  startSec: number,
  endSec: number,
): Promise<Map<number, number>> {
  const step = interval === "1s" ? 1 : 60;
  const chunks: number[] = [];
  for (let s = startSec; s < endSec; s += 1000 * step) chunks.push(s);
  const out = new Map<number, number>();
  const pages = await pool(chunks, 6, (s) =>
    fetchJsonRetry(
      `${binanceBase()}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${s * 1000}&endTime=${Math.min(endSec, s + 1000 * step) * 1000 - 1}&limit=1000`,
    ) as Promise<unknown[][]>,
  );
  for (const page of pages) for (const k of page) out.set(Number(k[0]) / 1000, Number(k[1]));
  return out;
}

/** O(1) mean of a 1s price map over [a, b) (missing seconds skipped). */
export function rangeAverager(sec: Map<number, number>, from: number, to: number) {
  const n = to - from;
  const sum = new Float64Array(n + 1);
  const cnt = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = sec.get(from + i);
    sum[i + 1] = sum[i]! + (v ?? 0);
    cnt[i + 1] = cnt[i]! + (v ? 1 : 0);
  }
  return (a: number, b: number): number => {
    const i = Math.max(0, a - from), j = Math.min(n, b - from);
    if (j <= i) return NaN;
    const c = cnt[j]! - cnt[i]!;
    return c ? (sum[j]! - sum[i]!) / c : NaN;
  };
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");

export function table(head: string[], rows: (string | number)[][]): void {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r: (string | number)[]) => r.map((c, i) => String(c).padStart(w[i]!)).join("  ");
  console.log(line(head));
  for (const r of rows) console.log(line(r));
  console.log();
}
