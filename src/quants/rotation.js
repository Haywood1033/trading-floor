// Momentum rotation: the same strategy the fair backtest measures (src/portfolioBacktest.js,
// "Momentum rotation, top 3"), as a quant that proposes orders.
//
// On each rebalance it ranks the ETF universe by 12-1 month return, keeps the top N that are
// above their 200-day average with a positive score, and proposes:
//   - selling any fund it holds that is no longer a pick,
//   - buying or topping up picks to an equal share of the fund.
// Idle slots stay in cash (the backtest parks them in short Treasuries; the difference is small).

import { sma, last } from './indicators.js';
import { summarize } from '../core/portfolio.js';

export const QUANT_ID = 'mom';
const YEAR = 252, MONTH = 21;

export function rankUniverse(bars, universe) {
  const out = [];
  for (const symbol of universe) {
    const c = bars[symbol];
    if (!c || c.length < YEAR + 1) { out.push({ symbol, score: null, ok: false, why: 'under a year of history' }); continue; }
    const score = c[c.length - 1 - MONTH] / c[c.length - 1 - YEAR] - 1;
    const above = last(c) > sma(c, 200);
    out.push({ symbol, score, above200: above, ok: score > 0 && above, why: score <= 0 ? '12-1 return negative' : !above ? 'below its 200-day average' : 'qualifies' });
  }
  return out.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
}

// held: { SYM: qty } positions this quant owns. prices: current prices.
export function runRotation(snapshot, bars, { universe, held = {}, topN = 3, cashBuffer = 0.05, minOrderValue = 0, metaFor = () => ({}) } = {}) {
  const equity = summarize(snapshot).equity;
  const ranked = rankUniverse(bars, universe);
  const picks = ranked.slice(0, topN).filter(r => r.ok).map(r => r.symbol);
  const target = equity * (1 - cashBuffer) / topN;
  const proposals = [];
  const rankOf = sym => ranked.findIndex(r => r.symbol === sym) + 1;
  const price = sym => snapshot.positions[sym]?.price ?? last(bars[sym]);

  for (const [sym, qty] of Object.entries(held)) {
    if (picks.includes(sym) || !(qty > 0)) continue;
    const r = ranked.find(x => x.symbol === sym);
    proposals.push({
      quantId: QUANT_ID, symbol: sym, side: 'sell', qty, price: price(sym), assetClass: 'etf', sector: metaFor(sym)?.sector,
      strength: 1, confidence: 0.55, horizon: '1m',
      thesis: `Rotation exit: ${sym} is now #${rankOf(sym)} of ${universe.length}` + (r && !r.ok ? ` (${r.why})` : ` (outside the top ${topN})`) + '. Sell all.'
    });
  }
  for (const sym of picks) {
    const have = (held[sym] || 0) * price(sym);
    const gap = target - have;
    if (gap < Math.max(minOrderValue, target * 0.1)) continue;    // within 10% of target: leave it
    const qty = Math.floor(gap / price(sym) * 1000) / 1000;
    if (qty <= 0) continue;
    const r = ranked.find(x => x.symbol === sym);
    proposals.push({
      quantId: QUANT_ID, symbol: sym, side: 'buy', qty, price: price(sym), assetClass: 'etf', sector: metaFor(sym)?.sector,
      strength: 1, confidence: 0.55, horizon: '1m',
      thesis: `Rotation pick: ${sym} (${metaFor(sym)?.name || sym}) is #${rankOf(sym)} of ${universe.length} on 12-1 month return (+${(r.score * 100).toFixed(0)}%), above its 200-day average. ` +
        `${have ? 'Top up' : 'Buy'} to ~${(target / equity * 100).toFixed(0)}% of the fund (~$${Math.round(gap)}).`
    });
  }
  return { ranked, picks, proposals: proposals.sort((a, b) => (a.side === 'sell' ? -1 : 1) - (b.side === 'sell' ? -1 : 1)) };
}
