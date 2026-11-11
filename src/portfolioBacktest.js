// Portfolio backtest: simulates holding real weights day by day, with trading costs, and
// reports the numbers that matter for running money (annual return, drawdown, volatility,
// worst year), not just how often calls were right.
//
// Rules that keep it honest:
// - Signals use closes up to day t; trades execute at day t+1's close (no same-day peeking).
// - Every rebalance pays costBps on the value traded (spread and slippage; commissions are 0).
//   costBps can be a number or a function of the symbol (cash-like SHY trades for ~1 bp).
// - A fund only becomes eligible once it has a full year of history at that date.
// - Signals read the total-return series (hist.tr: dividends reinvested). Holdings are valued at
//   actual closes, and dividends are paid into cash on their ex-date (hist.divs).

import { sma } from './quants/indicators.js';
import { mrSignals, RULES as MR_RULES } from './quants/meanReversion.js';
import { cryptoSignals, COINS } from './quants/cryptoTrend.js';

const YEAR = 252, MONTH = 21;

const sig = hist => hist.tr || hist.closes;
function series(hist, sym, t) {
  const arr = sig(hist)[sym];
  const out = [];
  for (let i = 0; i <= t; i++) { const v = arr?.[i]; if (v != null) out.push(v); }
  return out;
}

// The last n known closes up to day t (fast path for strategies checked every day).
function tail(hist, sym, t, n) {
  const arr = sig(hist)[sym];
  if (!arr) return [];
  const out = [];
  for (let i = t; i >= 0 && out.length < n; i--) if (arr[i] != null) out.push(arr[i]);
  return out.reverse();
}

// ---- strategies: (hist, t, { weights }) -> { SYM: weight } summing to 1, or null for "no trade
// today". `weights` are the current holdings as fractions of the portfolio at day t's close.

export const buyAndHold = sym => () => ({ [sym]: 1 });

export const fixedMix = mix => () => ({ ...mix });

export function equalWeight(universe) {
  return (hist, t) => {
    const live = universe.filter(s => hist.closes[s]?.[t] != null && series(hist, s, t).length > YEAR);
    return Object.fromEntries(live.map(s => [s, 1 / live.length]));
  };
}

// Relative-strength rotation: rank by 12-1 month return, hold the top N equally, but only
// those above their 200-day average and with a positive score; empty slots go to cash.
export function momentumRotation(universe, { topN = 3, cash = 'SHY', trendFilter = true } = {}) {
  return (hist, t) => {
    const scored = [];
    for (const s of universe) {
      const c = series(hist, s, t);
      if (c.length < YEAR + 1 || hist.closes[s][t] == null) continue;
      const score = c[c.length - 1 - MONTH] / c[c.length - 1 - YEAR] - 1;
      const ok = !trendFilter || (score > 0 && c.at(-1) > sma(c, 200));
      scored.push({ s, score, ok });
    }
    scored.sort((a, b) => b.score - a.score);
    const picks = scored.slice(0, topN).filter(x => x.ok).map(x => x.s);
    const w = Object.fromEntries(picks.map(s => [s, 1 / topN]));
    const idle = 1 - picks.length / topN;
    if (idle > 1e-9) w[cash] = (w[cash] || 0) + idle;
    return w;
  };
}

// Mean reversion (src/quants/meanReversion.js), checked daily. Each position is 1/maxPositions
// of the portfolio; open slots sit in cash. Held positions keep their current weight (no
// rebalancing between entries and exits).
export function meanReversion(universe, { cash = 'SHY', rules = MR_RULES } = {}) {
  const entered = {};                                 // symbol -> day index of entry
  return (hist, t, { weights }) => {
    const known = {};
    for (const s of universe) { if (hist.closes[s]?.[t] == null) continue; const c = tail(hist, s, t, rules.trendDays + 120); if (c.length) known[s] = c; }
    const held = Object.fromEntries(Object.keys(entered).map(s => [s, t - entered[s]]));
    const { exits, entries } = mrSignals(known, universe, held, rules);
    if (!exits.length && !entries.length) return null;
    for (const e of exits) delete entered[e.symbol];
    for (const e of entries) entered[e.symbol] = t + 1;  // filled at the next close
    const w = {};
    for (const s of Object.keys(entered)) w[s] = entries.some(e => e.symbol === s) ? 1 / rules.maxPositions : (weights[s] || 0);
    const used = Object.values(w).reduce((a, b) => a + b, 0);
    if (used < 1 - 1e-9) w[cash] = 1 - used;
    return w;
  };
}

// Crypto trend (src/quants/cryptoTrend.js): equal shares of the coins above their 200-day
// average, the rest in cash, checked every 5 trading days.
export function cryptoTrend({ coins = COINS, cash = 'SHY' } = {}) {
  return (hist, t) => {
    const known = {};
    for (const s of coins) { const c = tail(hist, s, t, 260); if (c.length && hist.closes[s][t] != null) known[s] = c; }
    const live = coins.filter(s => known[s]?.length > 200);
    if (!live.length) return { [cash]: 1 };
    const { want } = cryptoSignals(known, live);
    const w = Object.fromEntries(want.map(s => [s, 1 / live.length]));
    const used = want.length / live.length;
    if (used < 1 - 1e-9) w[cash] = 1 - used;
    return w;
  };
}

// ---- simulation

export function simulate(hist, strategy, { from, to, costBps = 10, every = MONTH, capital = 10000 } = {}) {
  const start = Math.max(hist.dates.findIndex(d => d >= from), 0);
  let end = to ? hist.dates.findLastIndex(d => d <= to) : hist.dates.length - 1;
  if (end < 0) end = hist.dates.length - 1;
  const holdings = {};          // symbol -> units
  let cashBal = capital, costs = 0, turnover = 0, rebalances = 0, pending = null;
  const equity = [];
  // A missing close (a coin with no print on a US trading day) carries the last known price.
  const lastSeen = {};
  const price = (s, t) => { const v = hist.closes[s]?.[t]; if (v != null) lastSeen[s] = v; return v ?? lastSeen[s] ?? null; };
  const value = t => cashBal + Object.entries(holdings).reduce((a, [s, u]) => a + u * (price(s, t) ?? 0), 0);

  let dividends = 0;
  for (let t = start; t <= end; t++) {
    // Dividends: whoever held the fund going into its ex-date gets the cash.
    if (hist.divs) for (const [s, u] of Object.entries(holdings)) {
      const d = hist.divs[s]?.[t];
      if (d) { cashBal += u * d; dividends += u * d; }
    }
    if (pending) {                                    // execute yesterday's decision at today's close
      const v = value(t);
      const target = {};
      for (const [s, w] of Object.entries(pending)) if (price(s, t) != null) target[s] = w * v;
      const current = Object.fromEntries(Object.entries(holdings).map(([s, u]) => [s, u * price(s, t)]));
      let traded = 0, cost = 0;
      for (const s of new Set([...Object.keys(target), ...Object.keys(current)])) {
        const d = Math.abs((target[s] || 0) - (current[s] || 0));
        traded += d;
        cost += d * (typeof costBps === 'function' ? costBps(s) : costBps) / 1e4;
      }
      costs += cost; turnover += traded / v; rebalances++;
      for (const s of Object.keys(holdings)) delete holdings[s];
      const invested = Object.values(target).reduce((a, b) => a + b, 0);
      const scale = (v - cost) / v;
      for (const [s, amt] of Object.entries(target)) holdings[s] = amt * scale / price(s, t);
      cashBal = (v - invested) * scale;
      pending = null;
    }
    if ((t - start) % every === 0 && t < end) {
      const v = value(t);
      const weights = Object.fromEntries(Object.entries(holdings).map(([s, u]) => [s, u * price(s, t) / v]));
      pending = strategy(hist, t, { weights });
    }
    equity.push({ date: hist.dates[t], value: value(t) });
  }
  return { equity, costs, dividends, turnoverPerYear: turnover / (equity.length / YEAR), rebalances };
}

// ---- metrics

export function metrics(equity, rfEquity) {
  const n = equity.length;
  const years = (n - 1) / YEAR;
  const first = equity[0].value, last = equity[n - 1].value;
  const cagr = Math.pow(last / first, 1 / years) - 1;
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(equity[i].value / equity[i - 1].value - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(YEAR);
  let rf = 0;
  if (rfEquity && rfEquity.length === n) rf = Math.pow(rfEquity[n - 1].value / rfEquity[0].value, 1 / years) - 1;
  let peak = first, peakDate = equity[0].date, maxDD = 0, ddPeak = null, ddTrough = null;
  for (const p of equity) {
    if (p.value > peak) { peak = p.value; peakDate = p.date; }
    const dd = p.value / peak - 1;
    if (dd < maxDD) { maxDD = dd; ddPeak = peakDate; ddTrough = p.date; }
  }
  const yearly = {};
  let prev = first;
  for (let i = 0; i < n; i++) {
    const y = equity[i].date.slice(0, 4);
    const isLast = i === n - 1 || equity[i + 1].date.slice(0, 4) !== y;
    if (isLast) { yearly[y] = equity[i].value / prev - 1; prev = equity[i].value; }
  }
  const months = {};
  let mprev = first;
  for (let i = 0; i < n; i++) {
    const m = equity[i].date.slice(0, 7);
    if (i === n - 1 || equity[i + 1].date.slice(0, 7) !== m) { months[m] = equity[i].value / mprev - 1; mprev = equity[i].value; }
  }
  const mv = Object.values(months);
  const worst = Object.entries(yearly).sort((a, b) => a[1] - b[1])[0];
  return {
    from: equity[0].date, to: equity[n - 1].date, years: +years.toFixed(2),
    cagr, vol, sharpe: vol ? (cagr - rf) / vol : 0, maxDrawdown: maxDD, drawdownFrom: ddPeak, drawdownTo: ddTrough,
    worstYear: worst ? { year: worst[0], ret: worst[1] } : null,
    positiveMonths: mv.filter(r => r > 0).length / mv.length,
    growthOf10k: 10000 * last / first, yearly
  };
}
