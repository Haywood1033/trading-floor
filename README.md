# Trading Floor

Personal automated trading desk for my own brokerage accounts. Quants propose trades,
a risk manager enforces hard limits, and I approve each trade (later: auto-execute
within limits). This is not a brokerage and never handles anyone else's money.

**The app** (`app/`, served at the site root on Vercel) is being built in three phases:
1. **Phase 1 (now): the full app on real market history.** A simulated $1,000 fund (fractional
   shares) on a replay of real daily closes from a start date you pick; every desk and control
   works end to end, synced across devices.
2. **Phase 2: paper validation** with real market data.
3. **Phase 3: live execution** through a broker API, within the manager's limits.

Phase 1 desks (all built):
- **Floor**: overview, approval queue, risk gauges, quant bench, activity log
- **Portfolio**: NAV vs SPY, allocation by asset class and sector, every position with cost and P&L, close a position
- **Risk**: edit every limit, auto-trade rules and sector caps; live exposure; blocked orders and limit changes
- **Quants**: each quant's rules, today's ranking/review, mode, capital cap, full call history
- **Blotter**: every order with filters, and the manager's trade ticket (same risk checks)
- **Security**: login status, connections, kill switch, day-trade and wash-sale watch, searchable audit log, export and reset
- **Reports**: daily brief, fund vs SPY, performance by source, monthly summary

The original static mockup is still at `/mockup/`.

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
4. ✅ Accuracy tracking and tiers (`src/tracking/`): every proposal is recorded as a call and
   graded after 63 trading days against SPY (or BTC for coins). Tiers use the Wilson lower bound
   of the hit rate and need 20+ graded calls. `npm run quants` records calls, `npm run grade` grades
   due calls and prints each quant's record.
5. ✅ Momentum quant (`src/quants/momentum.js`): buys the top 5 of a 19-name universe on
   12-1 month return, above the 200-day average, sized to ~5% of the account.
6. ⬜ Approval-mode execution with phone notifications.
7. ⬜ Auto mode within limits, for proven quants only.

## Hosting

Needs a long-running process during market hours (small VPS, Railway or Fly.io),
with Supabase Postgres for state, signals, fills and the audit log. Vercel serverless
alone does not fit a live trading loop.

## Code layout

- `app/index.html`, `app/styles.css`, `app/main.js`: app shell, navigation, simulated clock, saving
- `app/replay.js`: real-history replay: plays `state/history` forward from the fund's start date;
  each day moves from yesterday's real close to today's along a seeded path and ends exactly on
  the real close; quants only see completed days
- `app/sim.js`: synthetic market (fallback if history can't load, and tests)
- `src/quants/rotation.js`: the momentum rotation the backtest measures (top 3 ETFs, rebalanced
  every 21 trading days), used as the Momentum quant in replay funds
- `app/desk.js`: the fund and every manager/desk action; all fills go through the risk manager
- `app/floor.js`: Floor desk; `app/desks/*.js`: the other six desks; `app/ui.js`: shared charts, gauges, bars
- `src/node/fileStores.js`: file-backed stores for Node scripts (kept out of the browser engine)

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
- `src/quants/momentum.js`: momentum quant
- `src/tracking/tracker.js`, `src/tracking/stats.js`: call recording, grading, Wilson-bound tiers
- `scripts/quants.js`: runs every quant, risk-checks and records each call (never trades)
- `scripts/grade.js`: grades due calls, prints the scoreboard

### How calls are graded

A buy is right if the stock beat its benchmark over the next 63 trading days; a sell is right
if the stock trailed it (selling avoided the underperformance). The benchmark is SPY for stocks
and BTC for other coins. Tiers: Elite (lower bound ≥ 55%), All-Star (≥ 50%), Value (hit rate
≥ 52% and beating the benchmark on average), otherwise Unproven. Only proven tiers can auto-trade.

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

## Price history and the fair backtest (GitHub Actions, no accounts or keys)

`.github/workflows/history.yml` runs each weekday after the close and on demand:
- `scripts/fetch-history.js` pulls daily adjusted closes from Yahoo for the 21-fund ETF universe
  (`src/data/universe.js`) plus BTC and ETH, into `state/history/` (one file per year).
- `scripts/backtest-etf.js` runs `src/portfolioBacktest.js` on that history and writes
  `state/backtest-etf.json`.

The backtest uses ETFs that all existed from 2006, so the list isn't survivorship-biased. It
simulates real holdings with monthly rebalancing, 10 bps cost per dollar traded, and next-day
execution, and compares momentum rotation against SPY, 60/40 and equal weight, over the full
period and two halves (to 2016, and 2017 on).

## Server sync and login (Vercel)

The fund is stored on the server so every device sees the same desk.

1. **Storage** (needed for sync): project → Storage → create an **Upstash Redis** database (free)
   → connect it to this project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` itself.
2. **Password** (optional, off for now): project → Settings → Environment Variables → add
   `APP_PASSWORD`. Without it the fund syncs with no login, open to anyone with the address.

Redeploy after changing either. Without storage the API answers 503 and the app keeps the fund
in the browser.

- `api/fund.js` (GET full or `?meta=1`, PUT with revision), `api/login.js`, `api/logout.js`
- `server/handlers.js`, `server/store.js` (compare-and-set on a revision number),
  `server/auth.js` (HttpOnly session cookie derived from the password)
- `app/sync.js`: compresses the fund, saves with revisions, polls for changes, and passes a
  20-second clock lease so only one device runs the simulated market at a time
