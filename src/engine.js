// One full pass of the desk: snapshot the account, run every quant, risk-check each
// proposal, record the calls, grade any that are due, and return a feed for the UI.
// Never places orders.

import { reviewPortfolio } from './quants/portfolioReviewer.js';
import { runMomentum, DEFAULT_UNIVERSE } from './quants/momentum.js';
import { evaluateOrder, maxQtyWithinLimits } from './risk/riskManager.js';
import { summarize } from './core/portfolio.js';
import { DEFAULT_LIMITS } from './risk/limits.js';
import { last } from './quants/indicators.js';

export const QUANT_NAMES = { rev: 'Portfolio reviewer', mom: 'Momentum' };

// prices: { [symbol]: number[] } daily closes. closesAfter: optional (sym, date) => closes, for grading.
export async function runDesk({ snapshot, prices, tracker, closesAfter, source, now = new Date() }) {
  const reviewer = reviewPortfolio(snapshot, prices);
  const momentum = runMomentum(snapshot, prices);
  const proposals = [];

  for (const p of [...reviewer.proposals, ...momentum.proposals]) {
    let risk = evaluateOrder(p, snapshot);
    let resizedFrom = null;
    if (!risk.approved && p.side === 'buy') {
      const fit = maxQtyWithinLimits(p, snapshot);
      if (fit > 0) { resizedFrom = p.qty; p.qty = fit; risk = evaluateOrder(p, snapshot); }
    }
    const benchmark = p.assetClass === 'crypto' && p.symbol !== 'BTC' ? 'BTC' : 'SPY';
    const { recorded } = tracker.record(p, { benchmark, benchEntry: last(prices[benchmark]), issuedOn: now.toISOString().slice(0, 10) });
    proposals.push({ ...p, resizedFrom, newCall: recorded, risk });
  }

  const graded = closesAfter ? await tracker.gradeOpen(closesAfter) : [];
  const totals = summarize(snapshot);

  return {
    generatedAt: now.toISOString(),
    source,
    account: {
      equity: totals.equity, cash: totals.cash, stocks: totals.stocks, crypto: totals.crypto,
      startOfDayEquity: snapshot.startOfDayEquity, dayTradesUsed: snapshot.dayTradesUsed ?? null
    },
    positions: snapshot.positions,
    limits: DEFAULT_LIMITS,
    reviews: reviewer.reviews,
    momentum: momentum.ranked,
    proposals,
    gradedToday: graded.map(s => s.id),
    scoreboard: tracker.scoreboard().map(q => ({ ...q, name: QUANT_NAMES[q.quantId] || q.quantId }))
  };
}

export function symbolsNeeded(snapshot) {
  return [...new Set(['SPY', 'BTC', ...Object.keys(snapshot.positions), ...DEFAULT_UNIVERSE])];
}
