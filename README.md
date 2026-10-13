# Trading Floor

Personal automated trading desk for my own brokerage accounts. Quants propose trades,
a risk manager enforces hard limits, and I approve each trade (later: auto-execute
within limits). This is not a brokerage and never handles anyone else's money.

Mockup: `mockup/index.html` (sample data, simulated prices).

## Desk roles

| Role | Component | Rule |
|---|---|---|
| Quants | Signal modules returning `{symbol, side, strength, confidence, horizon, thesis}` | Each quant starts in paper mode and earns live status through its graded record |
| Portfolio manager | Combines signals into target positions and sizes them | Weights quants by calibrated hit rate |
| Risk manager | Hard limits that can veto any order | Plain deterministic code, never an LLM |
| Security / compliance | Key storage, audit log, kill switch, day-trade and wash-sale checks | Kill switch works even if everything else is down |
| Execution | Broker adapters, order placement, fill reconciliation | Limit orders by default |
| Accuracy tracking | Grades every signal after its horizon | Drives the Elite / All-Star / Value / Unproven tiers |

## Brokers

- **Crypto:** Robinhood Crypto Trading API (official).
- **Stocks:** Robinhood Agentic Trading beta if the account gets access; otherwise Alpaca
  (paper first), with Robinhood kept for read-only portfolio sync.
- No unofficial Robinhood stock libraries (unsupported, likely against terms of service).
- All broker access goes through one adapter interface so a broker can be swapped.

## Starting risk limits

| Limit | Value |
|---|---|
| Max single stock position | 10% of equity |
| Max tech exposure | 40% |
| Max crypto exposure | 20% |
| Cash floor | 5% |
| Daily loss cap | −2% (blocks new buys) |
| Auto-trade size cap | $1,500 per order |
| Day trades | 3 per rolling 5 days |

## Build order

1. ⬜ Broker adapters in read-only mode: sync holdings, cash and prices.
   Interface, paper broker and Alpaca adapter done (`src/brokers/`); `npm run sync` prints the
   Alpaca paper account read-only. Robinhood crypto (read-only) next.
2. ✅ Risk manager, kill switch, execution gate and audit log, with tests (`src/risk/`, `src/core/`).
3. ✅ Portfolio reviewer quant (`src/quants/portfolioReviewer.js`): flags stagnant holdings and
   oversized positions, proposes sells for the approval queue. `npm run review` on sample data;
   `npm run review -- --alpaca` on the paper account once it's connected.
4. ⬜ Accuracy tracking and tiers per quant.
5. ⬜ Momentum quant in paper mode.
6. ⬜ Approval-mode execution with phone notifications.
7. ⬜ Auto mode within limits, for proven quants only.

## Hosting

Needs a long-running process during market hours (small VPS, Railway or Fly.io),
with Supabase Postgres for state, signals, fills and the audit log. Vercel serverless
alone does not fit a live trading loop.

## Code layout

- `src/core/portfolio.js`: portfolio snapshots and exposure math (pure functions)
- `src/risk/limits.js`: the hard limits above
- `src/risk/riskManager.js`: `evaluateOrder`, `canAutoExecute`, `maxQtyWithinLimits`
- `src/risk/killSwitch.js`: halt/resume, persisted, fails closed on unreadable state
- `src/core/execute.js`: the only path to a broker: kill switch, then risk manager, then broker, all logged
- `src/core/auditLog.js`: append-only audit trail
- `src/brokers/adapter.js`, `src/brokers/paper.js`: broker interface and paper broker
- `src/brokers/alpaca.js`: Alpaca stocks + crypto; paper and read-only unless told otherwise
- `src/core/sectors.js`: symbol → sector lookup for the sector caps
- `scripts/sync.js`: read-only account printout
- `src/quants/portfolioReviewer.js`, `src/quants/indicators.js`: the portfolio reviewer quant
- `src/data/sample.js`: SAMPLE portfolio and synthetic prices, used until a broker is connected
- `scripts/review.js`: prints the reviewer's verdicts and proposed orders (never trades)

### Portfolio reviewer rules

Each holding is scored 0–6 against a benchmark (SPY for stocks, BTC for other coins):
trails the benchmark by more than 10% over 6 months (2 points) or by 5–10% (1);
down over 6 months (1); below its 200-day average (1); 50-day average under the
200-day (1); more than 20% off its 52-week high (1). 5+ is a sell, 3–4 a watch.
Stocks over the 10% position cap get a trim proposal. Confidence numbers are placeholders
until accuracy tracking grades the calls.

Run tests with `npm test` (Node 20+, no dependencies).

## Setup

Alpaca paper keys, never in the repo. Either:
- **Claude cloud environment (preferred):** add a network secret for `paper-api.alpaca.markets`
  and `data.alpaca.markets` with two custom headers, `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`
  (no prefix). The code never sees the keys.
- **Anywhere else:** set `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` as environment variables.

Then `npm run sync`.
