import {
  parseConfidence,
  type FactsForJev,
  type Judge,
  type JudgeOpinion,
  type Side,
} from "../../domain.js";
import { takerFeePerShare } from "../../policy.js";
import { fetchJson } from "../polymarket/wire.js";
import { sigmaPerSecBefore, twapFairUp, TWAP_SEC } from "../../model/twap.js";

const WINDOW_SEC = 300;

/** Binance klines [openTimeMs, open, high, low, close, ...] → rows. */
async function klines(base: string, interval: "1s" | "1m", startSec: number, endSec: number): Promise<unknown[][]> {
  return (await fetchJson(
    `${base}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${startSec * 1000}&endTime=${endSec * 1000 - 1}&limit=1000`,
  )) as unknown[][];
}

/**
 * Judge that prices the window with the TWAP settlement model on Binance data
 * (no LLM). It returns P(UP)/P(DOWN) and picks the side whose edge over its ask,
 * after the taker fee, is larger — so the policy's `P(win) ≥ ask + fee + MIN_EDGE`
 * check is the same rule the backtests used.
 *
 * followMove: always pick the side BTC is currently on vs the window open, so only
 * trades that agree with the move pass the edge check. On Sep 25–28 this matched the
 * Jev + TWAP combo (Jev's pick equals that side 98.5 % of the time) and beat plain TWAP.
 */
export function twapJudge(opts: {
  binanceBaseURL?: string;
  takerFeeRate: number;
  followMove?: boolean;
}): Judge {
  const base = (opts.binanceBaseURL || "https://api.binance.com").replace(/\/+$/, "");
  const sigmaByWindow = new Map<number, number>();

  return {
    async ask(facts: FactsForJev): Promise<JudgeOpinion> {
      const m = /-(\d+)$/.exec(facts.market.slug);
      if (!m) throw new Error(`twap judge: no window start in slug ${facts.market.slug}`);
      const ts = Number(m[1]);
      const end = ts + WINDOW_SEC;
      const now = Math.floor(Date.parse(facts.meta.composedAt) / 1000);

      let sigma = sigmaByWindow.get(ts);
      if (sigma == null) {
        const rows = await klines(base, "1m", ts - 3600, ts + 60);
        const min = new Map(rows.map((k) => [Number(k[0]) / 1000, Number(k[1])] as [number, number]));
        const s = sigmaPerSecBefore(min, ts);
        if (s == null) throw new Error("twap judge: not enough 1m history for volatility");
        sigma = s;
        sigmaByWindow.set(ts, s);
        if (sigmaByWindow.size > 4) sigmaByWindow.delete(sigmaByWindow.keys().next().value!);
      }

      // 1s candles from a minute before the window start up to now (≤ 360 rows).
      const rows = await klines(base, "1s", ts - TWAP_SEC, Math.min(now + 1, end));
      const opens = new Map(rows.map((k) => [Number(k[0]) / 1000, Number(k[1])] as [number, number]));
      const mean = (a: number, b: number) => {
        let sum = 0, n = 0;
        for (let t = a; t < b; t++) {
          const v = opens.get(t);
          if (v) { sum += v; n++; }
        }
        return n ? sum / n : null;
      };
      const k = mean(ts - TWAP_SEC, ts);
      const last = rows.at(-1);
      const st = last ? Number(last[4]) : null;
      if (k == null || st == null) throw new Error("twap judge: missing Binance 1s data");
      const tau = end - now;
      const pUp = twapFairUp({
        st,
        k,
        sigmaPerSec: sigma,
        tau,
        partial: tau < TWAP_SEC ? mean(end - TWAP_SEC, now + 1) : null,
      });

      const edge = (side: Side) => {
        const q = side === "UP" ? facts.market.up : facts.market.down;
        const ask = q.ask ?? q.mid;
        const p = side === "UP" ? pUp : 1 - pUp;
        return p - ask - takerFeePerShare(ask, opts.takerFeeRate);
      };
      const side: Side = opts.followMove
        ? facts.btc.moveVsWindowOpenPct >= 0 ? "UP" : "DOWN"
        : edge("UP") >= edge("DOWN") ? "UP" : "DOWN";
      const pSide = side === "UP" ? pUp : 1 - pUp;
      const confidence = parseConfidence(Math.min(1, Math.max(1e-6, pSide)))!;
      return { side, confidence, probs: { UP: pUp, DOWN: 1 - pUp } };
    },
  };
}
