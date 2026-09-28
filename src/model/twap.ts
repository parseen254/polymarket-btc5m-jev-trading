/**
 * Fair value of Polymarket's BTC Up/Down windows under their actual settlement rule:
 * Chainlink's 60s TWAP at the close ≥ the 60s TWAP at the open. Binance works as a
 * stand-in when compared the same way (60s average vs 60s average).
 */

/** Seconds of averaging in Polymarket's settlement (Chainlink btc-usd-twap-60s). */
export const TWAP_SEC = 60;

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

/** Per-√second volatility from the hour of 1m opens before `ts` (map: unixSec → open); null if too sparse. */
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

/**
 * P(UP) under the TWAP rule.
 *
 * k        TWAP over the minute before the window start (the price to beat)
 * st       latest price at time t
 * tau      seconds until the close
 * partial  mean price so far inside the final-minute averaging window (if tau < 60)
 *
 * Log-price is Brownian with σ per √s. Before the final minute, the average of the last
 * 60s has variance σ²(τ − 60 + 60/3). Inside it, the part already averaged is fixed and
 * only the remaining τ seconds (variance σ²τ/3) can move it.
 */
export function twapFairUp(args: {
  st: number;
  k: number;
  sigmaPerSec: number;
  tau: number;
  partial: number | null;
}): number {
  const { st, k, sigmaPerSec, tau } = args;
  if (tau >= TWAP_SEC) {
    return phi(Math.log(st / k) / (sigmaPerSec * Math.sqrt(tau - TWAP_SEC + TWAP_SEC / 3)));
  }
  const elapsed = TWAP_SEC - tau;
  const partial = args.partial ?? st;
  if (tau <= 0) return partial >= k ? 1 : 0;
  // Need mean of the remaining τ seconds ≥ k' so the full 60s average reaches k.
  const kRest = (TWAP_SEC * k - elapsed * partial) / tau;
  if (kRest <= 0) return 1;
  return phi(Math.log(st / kRest) / (sigmaPerSec * Math.sqrt(tau / 3)));
}

/** Spot-vs-spot digital (the rule Polymarket does *not* use); kept for comparison. */
export function fairUp(s: number, s0: number, sigmaPerSec: number, tau: number): number {
  if (tau <= 0) return s >= s0 ? 1 : 0;
  return phi(Math.log(s / s0) / (sigmaPerSec * Math.sqrt(tau)));
}
