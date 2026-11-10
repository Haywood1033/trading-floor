# Trading Floor

A personal trading desk run like a small fund: quants propose trades, a risk manager enforces
hard limits on every order (the manager's included), and the manager approves, or lets proven
quants trade on their own within limits. It is not a brokerage and never handles anyone else's
money.

Built in three phases:
1. **Phase 1 (now): the full app on real market history.** A simulated fund (default $1,000,
   fractional shares) on a replay of real daily closes from a start date the manager picks.
2. **Phase 2: paper validation** on live data.
3. **Phase 3: live execution** through a broker API, within the manager's limits.

## The app (`app/`, served at the site root on Vercel)

Desks:
- **Floor**: fund, approval queue, risk gauges, quant bench, activity log
- **Portfolio**: fund vs SPY, allocation, every position with cost, P&L and owner, close a position
- **Risk**: edit every limit, auto-trade rules and sector caps; live exposure; blocked orders
- **Quants**: each quant's rules, live view, mode (live/paper/off), sleeve, call history
- **Blotter**: every order with filters, and the manager's trade ticket
- **Security**: sync/login status, kill switch, day-trade and wash-sale watch, audit log, new fund
- **Reports**: the fair backtests, daily brief, fund vs SPY, performance by source, monthly summary

Code:
- `app/main.js`: controller (loading/saving, clock, routing, actions)
- `app/desk.js`: the fund and every action on it; every fill goes through the risk manager
- `app/replay.js`: real-history replay of `state/history`
- `app/sim.js`, `src/data/sample.js`: synthetic market used when history can't load, and in tests
- `app/floor.js`, `app/desks/*.js`, `app/ui.js`: screens
- `app/sync.js`, `api/*.js`, `server/*.js`: optional server sync (below)

## Quants

| Quant | Rules | Default |
|---|---|---|
| Momentum rotation (`src/quants/rotation.js`) | Top 3 of 20 ETFs by 12-1 month return, above their 200-day average; rebalanced every 21 trading days | Live, 60% sleeve |
| Mean reversion (`src/quants/meanReversion.js`) | Buy a fund above its 200-day average when RSI(2) < 10; sell above its 5-day average or after 10 days; up to 3 | Paper, 20% sleeve (no edge after costs in the backtest) |
| Crypto trend (`src/quants/cryptoTrend.js`) | Hold BTC and ETH only above their 200-day average; checked weekly | Live, 15% sleeve |
| Portfolio reviewer (`src/quants/portfolioReviewer.js`) | Scores the manager's own positions 0–6 for staleness; proposes sells and trims | Live |

Each quant sizes from its sleeve; the risk check caps it at its sleeve plus 5%. Positions record
how much each quant owns, so two quants can share a fund and each sells only its own part.

Every call is recorded and graded against its benchmark (SPY for funds, BTC for other coins)
after a horizon that fits the quant (63/10/21 days). Tiers use the Wilson lower bound of the hit
rate and need 20+ graded calls; only proven tiers may auto-trade unless the manager allows more.

## Risk manager (`src/risk/`)

Plain deterministic code, run on every order: kill switch, order size, position caps (stock and
ETF), crypto and sector caps, cash floor, daily loss and drawdown limits, day trades. Limits are
edited on the Risk desk.

## Price history and the fair backtest (GitHub Actions, no accounts or keys)

`.github/workflows/history.yml` runs each weekday after the close and on demand:
- `scripts/fetch-history.js` pulls daily closes from Yahoo for the 21-fund ETF universe
  (`src/data/universe.js`) plus BTC and ETH, into `state/history/` (one file per year).
- `scripts/backtest-etf.js` runs `src/portfolioBacktest.js` on that history and writes
  `state/backtest-etf.json`, which the Reports desk shows.

The backtest uses ETFs that all existed from 2006, so the list isn't survivorship-biased. It
simulates real holdings with 10 bps cost per dollar traded (1 bp into SHY, the cash fund) and
next-day execution, and compares each quant with simple alternatives over the full period and
two halves, plus the whole desk in sleeves with and without crypto.

## Server sync (Vercel, optional)

1. **Storage**: project → Storage → create an **Upstash Redis** database → connect it to this
   project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` itself.
2. **Password** (optional): add `APP_PASSWORD` under Environment Variables. Without it the fund
   syncs with no login, open to anyone with the address.

Redeploy after changing either. Without storage the API answers 503 and the fund stays in the
browser. The fund is stored compressed with a revision number (stale saves are refused), and a
clock lease lets only one device run the market at a time.

## Tests

`npm test` (Node 20+, no dependencies). `.github/workflows/test.yml` runs them on every pull
request and push to main.
