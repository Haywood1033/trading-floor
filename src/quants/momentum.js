// Momentum quant: buys the strongest stocks in a fixed universe.
//
// Score = 12-month return skipping the most recent month ("12-1"), the classic momentum
// measure (the last month tends to mean-revert, so it's left out). A stock must also be
// above its 200-day average. The top few that aren't already full positions get a buy
// proposal sized to a target weight. Exits are left to the portfolio reviewer.

import { sma, last } from './indicators.js';
import { summarize } from '../core/portfolio.js';
import { sectorOf } from '../core/sectors.js';

export const QUANT_ID = 'mom';
const YEAR = 252, MONTH = 21;

export const DEFAULT_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'AVGO', 'LLY', 'JPM', 'XOM',
  'COST', 'WMT', 'HD', 'UNH', 'TSLA', 'XLE', 'XLF', 'XLV', 'QQQ'
];

export function momentumScore(closes) {
  if (!closes || closes.length < YEAR + 1) return null;
  const from = closes[closes.length - 1 - YEAR];
  const to = closes[closes.length - 1 - MONTH];
  return to / from - 1;
}

// Returns { ranked: [...every scored name], proposals: [...buy orders] }
// fractional: size in thousandths of a share (brokers like Alpaca and Robinhood allow this),
// which small accounts need. minOrderValue skips top-ups too small to bother with.
export function runMomentum(snapshot, bars, {
  universe = DEFAULT_UNIVERSE, topN = 5, targetWeight = 0.05, minScore = 0.10, fractional = false, minOrderValue = 0
} = {}) {
  const equity = summarize(snapshot).equity;
  const ranked = [];
  for (const symbol of universe) {
    const closes = bars[symbol];
    const score = momentumScore(closes);
    if (score == null) { ranked.push({ symbol, score: null, eligible: false, why: 'not enough history' }); continue; }
    const price = last(closes);
    const above200 = price > sma(closes, 200);
    const eligible = above200 && score >= minScore;
    ranked.push({ symbol, score, price, above200, eligible,
      why: !above200 ? 'below its 200-day average' : score < minScore ? `12-1 return under ${minScore * 100}%` : 'qualifies' });
  }
  ranked.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

  const proposals = [];
  const leaders = ranked.filter(r => r.eligible).slice(0, topN);
  leaders.forEach((r, i) => {
    const held = snapshot.positions[r.symbol];
    const heldValue = held ? held.qty * held.price : 0;
    const gap = targetWeight * equity - heldValue;
    const qty = fractional ? Math.floor(gap / r.price * 1000) / 1000 : Math.floor(gap / r.price);
    if (qty <= 0 || qty * r.price < Math.max(minOrderValue, 1e-9)) { r.why = 'already at target weight'; return; }
    const rank = ranked.indexOf(r) + 1;
    proposals.push({
      quantId: QUANT_ID, symbol: r.symbol, side: 'buy', qty, price: r.price,
      sector: sectorOf(r.symbol), assetClass: 'stock',
      strength: 1 - i / topN, confidence: 0.55, horizon: '3m',
      thesis: `Momentum leader: #${rank} of ${universe.length} on 12-1 month return (+${(r.score * 100).toFixed(0)}%), above its 200-day average. ` +
        `Buy ${qty} (~$${(qty * r.price).toFixed(0)}) to reach ~${(targetWeight * 100).toFixed(0)}% of the account.`
    });
  });
  return { ranked, proposals };
}
