// Fair backtest on the ETF universe using state/history/. Writes state/backtest-etf.json.
//   node scripts/backtest-etf.js

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { joinHistory } from '../src/data/history.js';
import { ROTATION_UNIVERSE } from '../src/data/universe.js';
import { simulate, metrics, buyAndHold, fixedMix, equalWeight, momentumRotation } from '../src/portfolioBacktest.js';

const files = readdirSync('state/history').filter(f => /^\d{4}\.json$/.test(f)).map(f => JSON.parse(readFileSync(`state/history/${f}`, 'utf8')));
const hist = joinHistory(files);

// First date every rotation fund has a full year of history.
const firstFull = Math.max(...ROTATION_UNIVERSE.map(s => hist.closes[s].findIndex(v => v != null))) + 253;
const START = hist.dates[firstFull];
const COST = 10; // basis points per dollar traded

const STRATEGIES = [
  { id: 'spy', name: 'SPY buy and hold', fn: buyAndHold('SPY'), note: 'The bar to beat: own the S&P 500 and do nothing.' },
  { id: '6040', name: '60/40 (SPY/IEF)', fn: fixedMix({ SPY: 0.6, IEF: 0.4 }), note: 'Classic balanced portfolio, rebalanced monthly.' },
  { id: 'ew', name: 'Equal weight, all 20 funds', fn: equalWeight(ROTATION_UNIVERSE), note: 'Diversify across everything, no signal.' },
  { id: 'mom3', name: 'Momentum rotation, top 3', fn: momentumRotation(ROTATION_UNIVERSE, { topN: 3 }), note: 'Hold the 3 strongest funds (12-1 month) above their 200-day average; empty slots in SHY.' },
  { id: 'mom5', name: 'Momentum rotation, top 5', fn: momentumRotation(ROTATION_UNIVERSE, { topN: 5 }), note: 'Same, 5 funds.' },
  { id: 'mom3nf', name: 'Momentum top 3, no trend filter', fn: momentumRotation(ROTATION_UNIVERSE, { topN: 3, trendFilter: false }), note: 'Shows what the 200-day filter adds.' }
];

const mid = hist.dates.find(d => d >= '2017-01-01');
const PERIODS = [
  { id: 'full', label: `Full period (${START.slice(0, 4)}–now)`, from: START },
  { id: 'first', label: `${START.slice(0, 4)}–2016`, from: START, to: '2016-12-31' },
  { id: 'second', label: '2017–now', from: mid }
];

const results = { generatedAt: new Date().toISOString(), dataThrough: hist.dates.at(-1), costBps: COST, universe: ROTATION_UNIVERSE, start: START, periods: {} };
for (const p of PERIODS) {
  const rf = simulate(hist, buyAndHold('SHY'), { from: p.from, to: p.to, costBps: 0 }).equity;
  results.periods[p.id] = { label: p.label, strategies: STRATEGIES.map(s => {
    const r = simulate(hist, s.fn, { from: p.from, to: p.to, costBps: COST });
    const m = metrics(r.equity, rf);
    const curve = p.id === 'full' ? r.equity.filter((_, i) => i % 5 === 0 || i === r.equity.length - 1).map(e => [e.date, +e.value.toFixed(2)]) : undefined;
    return { id: s.id, name: s.name, note: s.note, ...m, costs: r.costs, turnoverPerYear: r.turnoverPerYear, curve };
  }) };
}
writeFileSync('state/backtest-etf.json', JSON.stringify(results));

const pct = v => (v * 100).toFixed(1).padStart(6) + '%';
for (const p of Object.values(results.periods)) {
  console.log(`\n${p.label}`);
  console.log('Strategy                              CAGR    Vol  Sharpe  Max DD  Worst yr   $10k ->');
  for (const s of p.strategies) console.log(`${s.name.padEnd(36)}${pct(s.cagr)}${pct(s.vol)}  ${s.sharpe.toFixed(2).padStart(5)} ${pct(s.maxDrawdown)}  ${s.worstYear?.year} ${pct(s.worstYear?.ret ?? 0)}  $${Math.round(s.growthOf10k).toLocaleString()}`);
}
