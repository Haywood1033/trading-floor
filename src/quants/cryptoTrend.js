// Crypto trend: hold each coin only while it is above its 200-day average; otherwise cash.
// Checked weekly (every 5 trading days) to avoid trading every wiggle. Fixed before testing.

import { sma, last } from './indicators.js';

export const QUANT_ID = 'cry';
export const COINS = ['BTC', 'ETH'];
export const RULES = { trendDays: 200, everyDays: 5 };

// Returns { want: [coins above trend], scan: [{ symbol, price, average, above }] }
export function cryptoSignals(bars, coins = COINS, rules = RULES) {
  const scan = [];
  for (const symbol of coins) {
    const c = bars[symbol];
    if (!c || c.length < rules.trendDays + 1) { scan.push({ symbol, price: c ? last(c) : null, average: null, above: null }); continue; }
    const average = sma(c, rules.trendDays);
    scan.push({ symbol, price: last(c), average, above: last(c) > average });
  }
  return { want: scan.filter(x => x.above).map(x => x.symbol), scan };
}
