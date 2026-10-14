// Portfolio reviewer quant: looks at what you already hold and flags dead weight.
//
// Every rule is simple and printed in the thesis, so you can see exactly why a holding
// was flagged. Confidence is a placeholder until accuracy tracking grades these calls.

import { ret, sma, drawdownFromHigh, last } from './indicators.js';
import { summarize } from '../core/portfolio.js';
import { DEFAULT_LIMITS } from '../risk/limits.js';

export const QUANT_ID = 'rev';
const SIX_MONTHS = 126;
const MIN_BARS = SIX_MONTHS + 5;

// Points toward "stale". Max 6 ("lagging" and "trailing" are exclusive).
export const MAX_SCORE = 6;
const RULES = [
  { id: 'lagging', pts: 2, test: m => m.rs6 != null && m.rs6 < -0.10, text: m => `trails ${m.benchmark} by ${pp(-m.rs6)} over 6 months` },
  { id: 'trailing', pts: 1, test: m => m.rs6 != null && m.rs6 >= -0.10 && m.rs6 < -0.05, text: m => `trails ${m.benchmark} by ${pp(-m.rs6)} over 6 months` },
  { id: 'negative', pts: 1, test: m => m.r6 < 0, text: m => `down ${pp(-m.r6)} in 6 months` },
  { id: 'below200', pts: 1, test: m => m.sma200 != null && m.price < m.sma200, text: () => 'below its 200-day average' },
  { id: 'downtrend', pts: 1, test: m => m.sma50 != null && m.sma200 != null && m.sma50 < m.sma200, text: () => '50-day average under the 200-day' },
  { id: 'drawdown', pts: 1, test: m => m.dd < -0.20, text: m => `${pp(-m.dd)} off its 52-week high` }
];
const SELL_AT = 5;
const WATCH_AT = 3;

const pp = v => (v * 100).toFixed(0) + '%';
const usd = v => '$' + Math.round(v).toLocaleString('en-US');

function metrics(closes, benchCloses, benchmark) {
  const r6 = ret(closes, SIX_MONTHS);
  const b6 = benchCloses ? ret(benchCloses, SIX_MONTHS) : null;
  return {
    price: last(closes),
    r6,
    rs6: b6 == null ? null : r6 - b6,
    benchmark,
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    dd: drawdownFromHigh(closes)
  };
}

// snapshot: risk-manager snapshot (positions carry qty, price, sector, assetClass, costBasis?)
// bars: { [symbol]: number[] } daily closes, oldest first. Include SPY, and BTC for crypto.
// Returns { reviews: [...one per holding], proposals: [...orders for the approval queue] }
export function reviewPortfolio(snapshot, bars, { limits = DEFAULT_LIMITS, stockBenchmark = 'SPY', cryptoBenchmark = 'BTC', fractional = false } = {}) {
  const totals = summarize(snapshot);
  const reviews = [];
  const proposals = [];

  for (const [symbol, pos] of Object.entries(snapshot.positions)) {
    const value = pos.qty * pos.price;
    const weight = value / totals.equity;
    const closes = bars[symbol];
    const isCrypto = pos.assetClass === 'crypto';
    const benchmark = isCrypto ? (symbol === cryptoBenchmark ? null : cryptoBenchmark) : stockBenchmark;

    if (!closes || closes.length < MIN_BARS) {
      reviews.push({ symbol, verdict: 'no-data', weight, reasons: [`needs ${MIN_BARS} days of history, has ${closes ? closes.length : 0}`] });
      continue;
    }

    const m = metrics(closes, benchmark ? bars[benchmark] : null, benchmark);
    const hits = RULES.filter(r => r.test(m));
    const score = hits.reduce((s, r) => s + r.pts, 0);
    const reasons = hits.map(r => r.text(m));
    const verdict = score >= SELL_AT ? 'sell' : score >= WATCH_AT ? 'watch' : 'ok';
    const review = { symbol, verdict, score, weight, value, metrics: m, reasons };
    reviews.push(review);

    const washNote = isCrypto ? '' : ' (wash-sale rule: no rebuy within 30 days to keep the loss)';
    const taxNote = pos.costBasis > 0
      ? (value < pos.costBasis ? ` Selling realizes a ${usd(pos.costBasis - value)} loss${washNote}.`
                               : ` Selling realizes a ${usd(value - pos.costBasis)} gain.`)
      : '';

    if (verdict === 'sell') {
      proposals.push({
        quantId: QUANT_ID, symbol, side: 'sell', qty: pos.qty, price: m.price,
        sector: pos.sector, assetClass: pos.assetClass,
        strength: score / MAX_SCORE, confidence: 0.55 + 0.05 * (score - SELL_AT), horizon: '3m',
        thesis: `Stale: ${reasons.join(', ')}. Sell all, frees ${usd(value)}.${taxNote}`
      });
      continue;
    }

    // Over the single-position cap: trim back to just under it, whatever the trend.
    if (!isCrypto && weight > limits.maxPositionPct) {
      const target = (limits.maxPositionPct - 0.005) * totals.equity;
      const raw = (value - target) / m.price;
      const qty = fractional ? Math.min(pos.qty, Math.ceil(raw * 1000) / 1000) : Math.ceil(raw);
      proposals.push({
        quantId: QUANT_ID, symbol, side: 'sell', qty, price: m.price,
        sector: pos.sector, assetClass: pos.assetClass,
        strength: 0.5, confidence: 0.6, horizon: 'now',
        thesis: `Over the ${pp(limits.maxPositionPct)} position limit at ${(weight * 100).toFixed(1)}%. Trim ${qty} to get back under.` +
          (reasons.length ? ` Also ${reasons.join(', ')}.` : '')
      });
    }
  }

  const order = { sell: 0, watch: 1, 'no-data': 2, ok: 3 };
  reviews.sort((a, b) => order[a.verdict] - order[b.verdict] || (b.score ?? 0) - (a.score ?? 0));
  return { reviews, proposals };
}
