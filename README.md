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
   Interface and paper broker done (`src/brokers/`); Alpaca and Robinhood crypto next.
2. ✅ Risk manager, kill switch, execution gate and audit log, with tests (`src/risk/`, `src/core/`).
3. ⬜ Portfolio reviewer quant (flags stagnant holdings): useful on day one, no execution needed.
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

Run tests with `npm test` (Node 20+, no dependencies).
