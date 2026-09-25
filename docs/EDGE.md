# Where the edge is (and isn't)

Findings from dry runs and a 7-day backtest (2,016 windows, Sep 18–25 2026), and a plan for finding an edge that lasts. Re-run the numbers yourself: `npm run backtest -- --days 7 --lags 0,2,5,10,20,40` and `npm run calibrate`.

## Reasoning check on the current strategy

The bot buys the side Jev favours when Jev's confidence is above 0.90 and P(win) ≥ ask + fee + 0.10, then holds to resolution.

| Check | Finding | Consequence |
|---|---|---|
| Is Jev a probability? | 44 of 46 logged answers were ≤ 0.05 or ≥ 0.95 (market: 9 of 46). With 271 s left and BTC −0.015 % (−$13), Jev said P(UP) = 0.02; the market said 0.445 and a volatility model ≈ 0.43. With 61 s left and BTC back to −0.005 %, Jev still said 0.03 vs market 0.335. | Jev reports the *sign* of the move, not a calibrated chance. The `P(win) ≥ ask + edge` check is always satisfied, so it filters nothing. |
| Is the market beatable on price level? | Market UP price vs actual UP rate (≥ 60 s left) lines up within ±1.2 points in every bucket from 0.05 to 0.95. No favourite–longshot bias. | "Buy cheap favourites" style rules have nothing to exploit. |
| Does a textbook model beat the market? | Brier score, market vs model: 0.238 vs 0.241 (5 min left) … 0.054 vs 0.075 (last minute). Market wins everywhere. | Public BTC price information is already in the price. Jev sees the same inputs, so it can't add information either. |
| Did the sim make money anyway? | Yes at zero lag (t-stat up to 5.6), but it halves by 5 s of lag and is gone by 10 s. | That is a speed race against stale quotes, not an edge. This bot ticks every 5 s and takes ~1 s per tick; HFT takers work at 50 ms. Not durable. |
| Right price feed? | Binance's open→close direction disagrees with the official Chainlink result in 229 / 2,016 windows (11.4 %). Binance sits $3–20 off Chainlink. | Near the open, a Binance-driven signal is wrong about one time in nine. |
| Fees | Taker fee = 0.07 × p × (1 − p) per share: 1.75 ¢ at 0.50, 1.47 ¢ at 0.70. | Breakeven win rate at a 0.70 entry is ~71.5 %, not 70 %. Now counted in policy and PnL. |
| Settlement bookkeeping (fixed) | The old code counted any side priced ≥ 0.70 right after the close as the winner. One dry-run trade that officially lost was about to be recorded as a win. | Dry-run PnL is now booked only on the official 1/0 result. |
| Live readiness | The live broker never redeems winning shares on-chain. | Live winnings would sit as unredeemed tokens until claimed on polymarket.com. |

**Verdict:** as built, Jev direction + taker entries has no edge. Don't take it live on the strength of a few winning windows.

## Why most edges here don't last

1. **Directional forecasting from public prices.** The market already prices it, and does so better than a volatility model. Any gain gets competed away.
2. **Latency.** It's real, but it's owned by co-located bots, and Polymarket keeps taxing it (dynamic taker fees, taker delay changes). Edges that come from how a platform behaves disappear when the platform changes.
3. **Rule-of-thumb thresholds** (confidence > 0.9, ask < 0.70). There's no mechanism behind them, so they have nothing to hold on to.

## Edges that can last: be paid for something the market needs

### A. Market making around a fair-value model (primary)

Takers pay 0.07 × p × (1 − p) per share, and 20 % of that goes back to makers as rebates. Makers pay no fee.

- Quote both sides of the book around a fair value `P(UP) = Φ(ln(S/S₀) / (σ√τ))`, with the spread set wider than the expected adverse move.
- Pull or re-price quotes the moment BTC moves. Being picked off by the latency traders above is the main risk, so the fair-value model's job is *protection*, not prediction.
- Keep inventory flat across UP/DOWN. UP + DOWN = $1 at resolution, so matched pairs are risk-free.
- **Why it lasts:** the edge is a service (liquidity) that the fee schedule structurally pays for. Competition compresses it, but it doesn't disappear the way a latency trick does.
- **What it needs:** a CLOB websocket (book plus own fills), post-only GTC orders, cancel/replace, inventory limits, and a maker fill simulator for dry runs. That's a new broker and policy; the domain, session and settlement code here can stay.

#### Attempt to disprove it (`npm run backtest:maker`)

Method: replay every taker trade from `data-api.polymarket.com/trades` (3 days, 864 windows, 1.33 M trades, 41 M shares) against hypothetical resting bids on UP and DOWN. Buying DOWN is the same as selling UP, so this is a two-sided quote. Fills count only when the taker sold at or below our bid, and at-price fills get a queue share `q`. Positions are held to the official result. Makers pay no fee and get about 0.3 ¢/share in rebates.

| Variant | Result |
|---|---|
| Bid at model − δ (model sets the price) | **Loses 7–10 ¢/share** at every δ and delay. The quote only gets hit when the market disagrees with the model, and the market is right more often. |
| Join the market's best bid, capped at model − δ, no inventory limit | Roughly break-even (−1.4 to +0.8 ¢/share, \|t\| < 1.2). 65–90 % of the inventory is one-sided: sellers dump the side that's losing. |
| Same, **inventory limit 20 shares** (stop bidding a side that leads by 20) | Positive. The result depends on requote delay (`L`, how stale the BTC price behind the cap is) and holds on each of the 3 days separately: |

| Requote delay L (inv 20, δ 0.03–0.05) | day 1 | day 2 | day 3 |
|---|---|---|---|
| 0 s | +1.5–2.5 ¢/sh, t 2.3–3.5 | +1.6–2.9 ¢/sh, t 3.1–4.6 | +1.4–2.7 ¢/sh, t 2.1–3.5 |
| **1 s** | +0.5–1.4 ¢/sh, t 1.1–2.0 | +0.8–1.9 ¢/sh, t 1.9–3.0 | +0.3–1.5 ¢/sh, t 0.8–2.0 |
| 2 s | −0.6–+0.4 ¢/sh, t −0.4–0.8 | −0.3–+0.7 ¢/sh, t 0.0–1.3 | −0.6–+0.3 ¢/sh, t −0.4–0.7 |

**Verdict: not disproven, but gated by speed.** Quoting at the market's bid with inventory control and a fast model cap made money on every day tested. The edge fades as the cap gets staler and is gone by 2 s. In practice that means Binance or Chainlink websockets, a CLOB websocket, and cancel/replace in well under a second. This bot's 5 s REST loop can't do it.

What this backtest can't see, and what could still kill it:
- **Queue position.** With no order-book data, at-price fills are a guess (`q`). The `q = 0` rows (strict price improvement only) are the conservative case.
- **Competition.** Our bids would take fills from existing makers, and they would react.
- **Cancel latency.** Polymarket's own cancel/match latency adds to `L`.
- **Short sample.** 3 days, and parameters were picked on the same data.

Next test: record the live L2 book over websocket and simulate queue position properly (paper maker). Then quote $1–2 live, because only real fills show the real queue.

### B. Read the settlement feed (supporting edge)

Polymarket settles on Chainlink BTC/USD, and its real-time data service streams that feed without auth (`wss://ws-live-data.polymarket.com`, topic `crypto_prices_chainlink`, about 1 update/s). Using it instead of Binance removes the 11.4 % wrong-sign error on close windows. That helps quoting in A most in the final minute, when the book is thinnest and mistakes are most expensive.

### C. Where Jev can still help

Jev is good at ranking and classifying, not at producing tick-level probabilities. Reasonable uses:
- A regime flag: "is this a news or volatility spike?" to widen spreads or stop quoting.
- A sanity veto on inputs.

Don't use it as the price.

## How to prove an edge before risking money

1. **Backtest with lag.** An edge must survive ≥ 5 s of lag, fees, and a spread you'd really pay. `npm run backtest -- --lags ...` does this for taker ideas.
2. **Out-of-sample.** Pick parameters on one week and test on the next. Re-run weekly; an edge that fades is a signal to stop.
3. **Forward dry run.** At least 300 settled trades with a t-stat > 2 after fees. `npm run calibrate` shows whether the live signal beats the market (Brier) before you look at PnL.
4. **Small live.** $1–5 size, and compare fills against the dry-run fill model. Scale only if they agree.
5. **Kill switch.** Stop automatically if rolling 200-trade PnL after fees goes negative.
