# Where the edge is (and isn't)

Findings from dry runs, 7 days of history (2,016 windows, Sep 18–25 2026), 3 days of taker trades (1.33 M trades), and a 90-minute recording of the live order book. Every number below can be re-run:

| Question | Command |
|---|---|
| Does Jev forecast better than the market? | `npm run calibrate` (after a dry run) |
| Fair-value model vs market, taker trades with data delay | `npm run backtest -- --days 7 --lags 0,1,2,5,10` |
| Maker bids against the real taker tape | `npm run backtest:maker -- --days 3` |
| Maker and taker on the real order book, with queue position | `npm run record:book -- 90` then `npm run paper:maker` |

## How these markets settle

A window resolves **UP if Chainlink's 60-second BTC/USD TWAP at the close is ≥ the 60 s TWAP at the open** (`btc-usd-twap-60s` stream; Gamma exposes `priceToBeat` and `finalPrice`). It is not spot vs spot, and the old Jev prompt's "TWAP" was right.

- **Binance works as a stand-in** if you compare the same way: 60 s average vs 60 s average matches the official result in 98.2 % of windows. Spot vs spot matches only 88.6 %, because the TWAP rule differs, not because the feeds differ. Binance sits about $18 above Chainlink, but that gap cancels out.
- The fair value is a TWAP digital (`twapFairUp` in `scripts/lib/history.ts`). Before the final minute, uncertainty includes averaging over it. Inside the final minute, the part of the average already observed is fixed.

## The Jev strategy (as shipped)

| Check | Finding |
|---|---|
| Are Jev's numbers probabilities? | No. In the 2 h dry run, when Jev said P(UP) < 10 % (568 answers, mean 1.7 %), UP won 15 %. Its forecasts score worse than the market's at every time left, and worse than a coin flip with 4–5 min left (Brier 0.274 vs market 0.182 vs coin 0.250). |
| Does the `confidence` field rank? | Poorly. Picks at 0.90–0.95 won 65 %, picks at 0.80–0.90 won 84 %. |
| Dry-run PnL | +$14.28 on 16 settled trades (t ≈ 0.8), all DOWN while BTC drifted down. That's a trend, not skill. |
| Fees | Taker fee = 0.07 × p × (1 − p) per share. Now in the edge check and in PnL. |
| Settlement bookkeeping | Fixed: PnL is booked on the official result, not on any side priced ≥ 0.70. |
| Live broker | Doesn't redeem winning shares. |

**Verdict: retire Jev as the price signal.**

## Taker entries on the TWAP model

Over 7 days of history, the TWAP model beats the market's forecast at every time left (Brier 0.233 vs 0.239 with 5 min left, 0.036 vs 0.054 in the last minute). The market prices, bucketed by price level, are well calibrated (within about ±1 point).

Buy when model − (price + 1¢) − fee ≥ θ, with ≥ 90 s left:

| Data delay | Result |
|---|---|
| 0–2 s | +4–19 ¢/trade, t 4–8 |
| 5 s | +2–17 ¢/trade, t up to 6.3 |
| 10 s | ≈ 0 |

**Caveat:** the history prices are about one sample per minute, not a tradable ask. On the recorded real book (15 windows, one trade per window) the result is noise (t between −1 and +0.8). **Not yet confirmed.** This is the most promising lead, and it fits the current bot's 5 s loop.

## Market making (quote at the bid, earn rebates)

The thesis: join the best bid on both outcomes, cap it at fair − δ, stop bidding a side that leads the other by 20 shares, earn ~0.3 ¢/share in rebates, and pay no fee.

| Test | Result |
|---|---|
| Bid at fair − δ (model sets the price), tape | −7 to −10 ¢/share. Only gets hit when the market disagrees, and the market is usually right. |
| Join the bid + inventory limit, tape, 3 days, TWAP model | Positive while the cap is fresh: +1–4 ¢/sh at 0–1 s delay (t 8–18), ≈ 0 at 2 s, −2 to −3 ¢/sh at 5 s. |
| **Same strategy on the real book** (15 windows, back-of-queue, cancels land 50–500 ms late) | **−4 to −6 ¢/share at every setting (t −2 to −4.5)**, even with 50 ms requotes and zero data delay. ~90 % of fills are pick-offs: a seller went below our bid before we moved (markout −3 to −7 ¢). Queue fills are rare and roughly flat. |
| Tape on the same 15 windows | −0.4 to −4 ¢/share. So the tape overstates the maker by about 2–4 ¢/share, roughly the whole edge it found over 3 days. |

**Verdict: the maker thesis fails on the real book at this speed.** Joining the bid gets you picked off by faster participants before you can move, and the rebate (~0.3 ¢) doesn't come close to covering it. 15 windows is a small sample, but the loss is uniform across every setting, and the diagnosis (pick-offs) is mechanical, not statistical.

## What's left and how to test it

1. **Taker on the TWAP model, against the real ask.** The only remaining lead. Record the book for ≥ 24 h (~200+ windows; about 600 MB gzipped, better done on your own machine) and re-run `npm run paper:maker`. Its taker table uses the real best ask and ask size. Look for t > 2 at 1–5 s delay.
2. If that holds: swap Jev for `twapFairUp` in the bot's policy, keep fee-aware entries, run the dry run for 300+ settled trades, then go live small with a kill switch (stop if rolling 200-trade PnL after fees goes negative).
3. Don't build the market maker unless you can quote and cancel much faster than 50 ms. That's a co-location game.

## How to prove an edge before risking money

1. Backtest with a realistic data delay, fees, and the price you'd really pay.
2. Confirm on the real order book, not sampled prices. Here that step cut the maker's 2–4 ¢/share edge to a loss.
3. Test out-of-sample: a different day or week than the one parameters were picked on.
4. Forward dry run: 300+ settled trades, t > 2 after fees.
5. Small live size with a kill switch. Compare real fills with the paper fills before scaling.
