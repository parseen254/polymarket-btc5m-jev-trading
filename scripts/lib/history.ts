import { fetchJson } from "../../src/adapters/polymarket/wire.js";

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
    fetchJson(
      `${binanceBase()}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${s * 1000}&endTime=${Math.min(endSec, s + 1000 * step) * 1000 - 1}&limit=1000`,
    ) as Promise<unknown[][]>,
  );
  for (const page of pages) for (const k of page) out.set(Number(k[0]) / 1000, Number(k[1]));
  return out;
}

/** Per-√second volatility from the hour of 1m returns before `ts`; null if too sparse. */
export function sigmaPerSecBefore(min: Map<number, number>, ts: number): number | null {
  const rets: number[] = [];
  for (let t = ts - 3600; t < ts; t += 60) {
    const a = min.get(t), b = min.get(t + 60);
    if (a && b) rets.push(Math.log(b / a));
  }
  if (rets.length < 30) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  return Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1) / 60);
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
export function phi(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Digital-option fair value of UP: P(S_end ≥ S_0) given S now and τ seconds left. */
export function fairUp(s: number, s0: number, sigmaPerSec: number, tau: number): number {
  if (tau <= 0) return s >= s0 ? 1 : 0;
  return phi(Math.log(s / s0) / (sigmaPerSec * Math.sqrt(tau)));
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
