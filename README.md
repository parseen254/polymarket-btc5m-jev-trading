# polymarket-btc5m-jev-trading

A terminal agent for Polymarket’s **BTC Up or Down 5-minute** markets.

It watches the live 5m window, asks [TypeSafe Jev](https://typesafe.ai) whether BTC finishes UP or DOWN vs the window open, and either **abstains** or **buys once** and holds to resolution. Default mode is **dry-run** (no real orders). Live trading is optional.

---

## Requirements

- Node.js 20+
- A Jev API key: either TypeSafe (`TYPESAFE_API_KEY`) or OpenRouter (`OPENROUTER_API_KEY`)

For live trading only: a Polygon wallet that already works on [Polymarket](https://polymarket.com) (connected, funded with USDC.e, able to trade in the browser). This project does **not** set allowances or deposits for you.

---

## Install

```bash
git clone https://github.com/VGabriel45/polymarket-btc5m-jev-trading.git
cd polymarket-btc5m-jev-trading
cp .env.example .env
npm install
```

Edit `.env` and set **one** of:

```bash
# TypeSafe direct
TYPESAFE_API_KEY=your_key_here

# or OpenRouter (model typesafe/jev-1.13, billed to your OpenRouter credits)
JEV_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
```

On OpenRouter the TypeSafe SDK is pointed at `https://openrouter.ai/api` (`POST /v1/systemone`); the request and response shapes are the same.

---

## Dry-run (recommended first)

```bash
npm run watch
```

Ink TUI opens. You should see **DRY-RUN**. Press `q` to quit.

One-shot tick (JSON to stdout):

```bash
npm run once
```

If Binance blocks your region (HTTP 451 on spot), point at Binance's public market-data mirror:

```bash
BINANCE_BASE_URL=https://data-api.binance.vision
```

Offline without a Jev key:

```bash
POLYMARKET_SOURCE=fixture npm run watch -- --stub-judge
```

---

## Live trading

1. On [polymarket.com](https://polymarket.com), connect the wallet you will use and confirm you can trade normally.
2. Add to `.env`:

```bash
LIVE_TRADING=1
WALLET_PVK=0x...              # private key of that wallet
POLYMARKET_FUNDER=0x...       # deposit / proxy address if Polymarket uses one
SIGNATURE_TYPE=3              # POLY_1271 deposit wallet (usual)
POLYMARKET_SOURCE=live
BET_USD=5
```

3. Run:

```bash
npm run watch
```

Confirm the TUI shows **LIVE TRADING**. Live mode posts **FOK** (fill-or-kill) market orders. Unfilled orders are cancelled, not left resting.

Do not combine live mode with `--stub-judge` or `POLYMARKET_SOURCE=fixture`.

---

## How it decides

Every ~5s (`TICK_MS`):

1. Load the current `btc-updown-5m-{unix}` market + BTC spot  
2. Ask Jev for side + confidence (+ probabilities)  
3. Apply policy:

| Situation | Action |
|-----------|--------|
| Confidence ≤ 0.90 | Wait |
| Ask too high, or no edge vs ask, or &lt; 90s left | Wait |
| Confidence &gt; 0.90 and edge ok | Buy once (≤ `BET_USD`) |
| Already in a position | Hold until the 5m window ends |

Winners are decided by Polymarket’s rules (Chainlink BTC vs price to beat), not by share odds.

Dry-run PnL is net of the taker fee and is booked only once Polymarket posts the official result for the window (usually ~1 minute after it closes). Every Jev answer is logged to `data/jev-log.jsonl`; run `npm run calibrate` to see whether Jev forecasts better than the market price before trusting it.

---

## Useful env vars

| Var | Default | What it does |
|-----|---------|--------------|
| `JEV_PROVIDER` | auto | `typesafe` or `openrouter` (auto: `openrouter` when only `OPENROUTER_API_KEY` is set) |
| `TYPESAFE_API_KEY` | — | Jev key for `typesafe` |
| `OPENROUTER_API_KEY` | — | Jev key for `openrouter` |
| `JEV_MODEL` | `jev-1.13.0` / `typesafe/jev-1.13` | Model override for the chosen provider |
| `POLYMARKET_SOURCE` | `auto` | `live`, `fixture`, or `auto` |
| `BINANCE_BASE_URL` | `https://api.binance.com` | Spot API root (`https://data-api.binance.vision` if geo-blocked) |
| `TICK_MS` | `5000` | Seconds between ticks (ms) |
| `ACT_THRESHOLD` | `0.90` | Min confidence to enter (must be **strictly greater**) |
| `MAX_ASK` | `0.70` | Max share price to buy |
| `MIN_EDGE` | `0.10` | Need P(win) ≥ ask + taker fee + this |
| `TAKER_FEE_RATE` | `0.07` | Polymarket crypto taker fee: `rate × p × (1 − p)` per share |
| `JEV_LOG_PATH` | `data/jev-log.jsonl` | Per-call Jev log for calibration (`off` to disable) |
| `BET_USD` | `5` | Max USD per entry |
| `LIVE_TRADING` | off | Set `1` for real CLOB orders |
| `WALLET_PVK` | — | Signer key (live only) |
| `POLYMARKET_FUNDER` | — | Funder / deposit wallet (live) |
| `SIGNATURE_TYPE` | `3` | `3` = POLY_1271 |

Full list is in `.env.example`.

---

## Scripts

```bash
npm run watch         # TUI loop
npm run once          # single tick
npm run dryrun -- 600 # headless dry-run loop, one line per tick (default 360s)
npm run calibrate     # Jev log × official outcomes: Brier vs market, reliability, fee-aware sim
npm run backtest -- --days 7   # no-Jev fair-value model vs market on past windows
npm run backtest:maker -- --days 3   # resting-bid (maker) replay against the real taker tape
npm run record:book -- 90            # record live L2 book + Binance + Chainlink to data/book/
npm run paper:maker                  # replay a queue-aware paper maker on the recordings
npm run typecheck
npm run smoke:policy  # offline policy checks
```

---

## Is there an edge?

Read [docs/EDGE.md](docs/EDGE.md) before going live. Short version:

- Jev's probabilities are overconfident and forecast worse than the market. Don't trade on them.
- A fair-value model of the actual settlement rule (60 s TWAP vs 60 s TWAP) beats the market's forecasts on 7 days of history. Taker entries on it look profitable with up to ~5 s of data delay, but that isn't yet confirmed against the real order book.
- Market making (joining the bid for rebates) looked good on the trade tape but loses 4–6 ¢/share on the real book: most fills are pick-offs.

---

## Disclaimer

Experimental software. Not financial advice. You can lose money. Not affiliated with Polymarket or TypeSafe beyond using their APIs/SDKs.
