// Backtest: replay the quants over real history and grade every call they would have made,
// exactly the way live calls are graded (63 trading days, relative to SPY).
//
// Caveats, also written into the results:
// - Survivorship bias: the momentum universe is today's large companies, which were by
//   definition winners. This flatters momentum.
// - No trading costs or slippage; grading is relative to SPY, not a full P&L simulation.

import { runMomentum, DEFAULT_UNIVERSE } from './quants/momentum.js';
import { reviewPortfolio } from './quants/portfolioReviewer.js';
import { gradeSignal } from './tracking/tracker.js';
import { wilsonLower, tierFor } from './tracking/stats.js';

const HORIZON = 63, STEP = 21, WARMUP = 260;

// history: { [symbol]: [{ date, c }] }. Everything is aligned to SPY's trading days.
export function alignToBenchmark(history, bench = 'SPY') {
  const dates = history[bench].map(b => b.date);
  const aligned = {};
  for (const [sym, rows] of Object.entries(history)) {
    const byDate = new Map(rows.map(r => [r.date, r.c]));
    let lastSeen = null;
    aligned[sym] = dates.map(d => (byDate.has(d) ? (lastSeen = byDate.get(d)) : lastSeen));
  }
  return { dates, closes: aligned };
}

function summarizeCalls(calls) {
  const n = calls.length;
  const hits = calls.filter(c => c.correct).length;
  const avgExcess = n ? calls.reduce((s, c) => s + c.excess, 0) / n : 0;
  return { n, hits, hitRate: n ? hits / n : null, lowerBound: wilsonLower(hits, n), avgExcess, tier: tierFor({ n, hits, avgExcess }) };
}

export function runBacktest(history, { universe = DEFAULT_UNIVERSE, bench = 'SPY' } = {}) {
  const { dates, closes } = alignToBenchmark(history, bench);
  const usable = universe.filter(s => closes[s]);
  const calls = { mom: [], rev: [], baseline: [] };

  for (let t = WARMUP; t + HORIZON < dates.length; t += STEP) {
    // Prices as they were known on day t (no look-ahead), trimmed of leading gaps.
    const known = {};
    for (const s of [bench, ...usable]) {
      const slice = closes[s].slice(0, t + 1).filter(v => v != null);
      if (slice.length) known[s] = slice;
    }
    const grade = (sym, side) => {
      const s = { side, entryPrice: closes[sym][t], benchEntry: closes[bench][t], horizonDays: HORIZON };
      if (s.entryPrice == null) return null;
      const r = gradeSignal(s, closes[sym].slice(t + 1), closes[bench].slice(t + 1));
      return r && { date: dates[t], symbol: sym, side, ...r };
    };

    // Momentum: what it would have proposed on day t.
    const cashOnly = { cash: 1e6, positions: {}, startOfDayEquity: 1e6 };
    const { proposals } = runMomentum(cashOnly, known, { universe: usable });
    for (const p of proposals) { const g = grade(p.symbol, 'buy'); if (g) calls.mom.push(g); }

    // Baseline: buying every universe name with enough history. Momentum has to beat this.
    for (const sym of usable) if (known[sym]?.length > 252) { const g = grade(sym, 'buy'); if (g) calls.baseline.push(g); }

    // Reviewer: pretend you held an equal slice of every universe name; grade its sell calls.
    const positions = {};
    for (const sym of usable) if (known[sym]) positions[sym] = { qty: 1000 / closes[sym][t], price: closes[sym][t], sector: 'Any', assetClass: 'stock' };
    const snap = { cash: 1e9, positions, startOfDayEquity: 1e9 };
    for (const r of reviewPortfolio(snap, known).reviews) {
      if (r.verdict === 'sell') { const g = grade(r.symbol, 'sell'); if (g) calls.rev.push(g); }
    }
  }

  const byYear = list => {
    const out = {};
    for (const c of list) (out[c.date.slice(0, 4)] ||= []).push(c);
    return Object.fromEntries(Object.entries(out).map(([y, l]) => [y, summarizeCalls(l)]));
  };

  return {
    period: { from: dates[WARMUP], to: dates[dates.length - 1 - HORIZON], tradingDays: dates.length },
    rules: { horizonDays: HORIZON, rebalanceEveryDays: STEP, benchmark: bench, universe: usable },
    momentum: { ...summarizeCalls(calls.mom), byYear: byYear(calls.mom) },
    baselineBuyEverything: summarizeCalls(calls.baseline),
    reviewer: { ...summarizeCalls(calls.rev), byYear: byYear(calls.rev) },
    caveats: [
      'Survivorship bias: the universe is today\'s large companies, which flatters momentum.',
      'No trading costs or slippage. Calls are graded relative to SPY over 63 trading days.',
      'Reviewer results assume you held an equal slice of every universe name.',
      'Prices from Yahoo Finance\'s unofficial endpoint (adjusted closes).'
    ],
    recentCalls: { momentum: calls.mom.slice(-15), reviewer: calls.rev.slice(-15) }
  };
}
