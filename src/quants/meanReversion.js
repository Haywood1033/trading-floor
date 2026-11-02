// Mean reversion: buy sharp short-term dips in funds that are still in a long-term uptrend,
// sell on the bounce. Rules are the standard RSI(2) version, fixed before testing:
//   enter  close above its 200-day average AND RSI(2) below 10
//   exit   close above its 5-day average, or 10 trading days after entry
//   size   at most 3 positions; if more qualify, the lowest RSI(2) first
// Shared by the backtest (src/portfolioBacktest.js) and the app quant.

import { rsi, sma, last } from './indicators.js';

export const QUANT_ID = 'mr';
export const RULES = { entryRsi: 10, trendDays: 200, exitDays: 5, maxHoldDays: 10, maxPositions: 3 };

// bars: { SYM: closes[] } up to today. held: { SYM: tradingDaysHeld }.
// Returns { exits: [{ symbol, why }], entries: [{ symbol, rsi, why }], scan: [...] }
export function mrSignals(bars, universe, held = {}, rules = RULES) {
  const exits = [];
  for (const [symbol, days] of Object.entries(held)) {
    const c = bars[symbol];
    if (!c || c.length < rules.exitDays) continue;
    if (last(c) > sma(c, rules.exitDays)) exits.push({ symbol, why: `closed above its ${rules.exitDays}-day average (the bounce)` });
    else if (days >= rules.maxHoldDays) exits.push({ symbol, why: `held ${days} trading days without a bounce (time stop)` });
  }
  const scan = [];
  for (const symbol of universe) {
    const c = bars[symbol];
    if (!c || c.length < rules.trendDays + 1) continue;
    const r = rsi(c, 2);
    const up = last(c) > sma(c, rules.trendDays);
    scan.push({ symbol, rsi: r, uptrend: up, signal: up && r != null && r < rules.entryRsi });
  }
  scan.sort((a, b) => a.rsi - b.rsi);
  const stillHeld = Object.keys(held).filter(s => !exits.some(e => e.symbol === s));
  const slots = Math.max(0, rules.maxPositions - stillHeld.length);
  const entries = scan.filter(x => x.signal && !(x.symbol in held)).slice(0, slots)
    .map(x => ({ symbol: x.symbol, rsi: x.rsi, why: `RSI(2) ${x.rsi.toFixed(1)} (oversold) while above its ${rules.trendDays}-day average` }));
  return { exits, entries, scan };
}
