// Fair backtest on the ETF universe using state/history/. Writes state/backtest-etf.json.
//   node scripts/backtest-etf.js

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { joinHistory } from '../src/data/history.js';
import { ROTATION_UNIVERSE } from '../src/data/universe.js';
import { simulate, metrics, buyAndHold, fixedMix, equalWeight, momentumRotation, meanReversion, cryptoTrend } from '../src/portfolioBacktest.js';

const files = readdirSync('state/history').filter(f => /^\d{4}\.json$/.test(f)).map(f => JSON.parse(readFileSync(`state/history/${f}`, 'utf8')));
const hist = joinHistory(files);

// First date every rotation fund has a full year of history.
const firstFull = Math.max(...ROTATION_UNIVERSE.map(s => hist.closes[s].findIndex(v => v != null))) + 253;
const START = hist.dates[firstFull];
const COST_BPS = 10;                                   // per dollar traded in any fund
const COST = sym => (sym === 'SHY' ? 1 : COST_BPS);     // moving idle cash into short Treasuries costs ~1 bp

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

const results = { generatedAt: new Date().toISOString(), dataThrough: hist.dates.at(-1), costBps: COST_BPS, cashCostBps: 1, universe: ROTATION_UNIVERSE, start: START, periods: {} };
for (const p of PERIODS) {
  const rf = simulate(hist, buyAndHold('SHY'), { from: p.from, to: p.to, costBps: 0 }).equity;
  results.periods[p.id] = { label: p.label, strategies: STRATEGIES.map(s => {
    const r = simulate(hist, s.fn, { from: p.from, to: p.to, costBps: COST });
    const m = metrics(r.equity, rf);
    const curve = p.id === 'full' ? r.equity.filter((_, i) => i % 5 === 0 || i === r.equity.length - 1).map(e => [e.date, +e.value.toFixed(2)]) : undefined;
    return { id: s.id, name: s.name, note: s.note, ...m, costs: r.costs, turnoverPerYear: r.turnoverPerYear, curve };
  }) };
}
// ---- the other quants, and the combined fund

const run = (fn, from, to, opts = {}) => simulate(hist, fn, { from, to, costBps: COST, ...opts });
const thin = eq => eq.filter((_, i) => i % 5 === 0 || i === eq.length - 1).map(e => [e.date, +e.value.toFixed(2)]);
function score(list, from, to, keepCurve) {
  const rf = simulate(hist, buyAndHold('SHY'), { from, to, costBps: 0 }).equity;
  return list.map(s => {
    const r = run(s.fn, from, to, s.opts);
    return { id: s.id, name: s.name, note: s.note, ...metrics(r.equity, rf), costs: r.costs, turnoverPerYear: r.turnoverPerYear, trades: r.rebalances, curve: keepCurve ? thin(r.equity) : undefined, _equity: r.equity };
  });
}
const strip = arr => arr.map(({ _equity, ...x }) => x);

// Mean reversion vs doing nothing clever, same periods as the rotation.
results.meanReversion = {};
for (const p of PERIODS) {
  results.meanReversion[p.id] = { label: p.label, strategies: strip(score([
    { id: 'spy', name: 'SPY buy and hold', fn: buyAndHold('SPY'), note: 'The bar to beat.' },
    { id: 'ew', name: 'Equal weight, all 20 funds', fn: equalWeight(ROTATION_UNIVERSE), note: 'No signal.' },
    { id: 'mr', name: 'Mean reversion (RSI 2)', fn: meanReversion(ROTATION_UNIVERSE), opts: { every: 1 }, note: 'Buy sharp dips above the 200-day average; sell on the bounce or after 10 days; up to 3 at once; idle cash in SHY.' },
    { id: 'mrlow', name: 'Mean reversion at 3 bps cost', fn: meanReversion(ROTATION_UNIVERSE), opts: { every: 1, costBps: s => (s === 'SHY' ? 1 : 3) }, note: 'Same rules; tighter cost assumption (liquid ETFs at the close). Shows how cost-sensitive it is.' }
  ], p.from, p.to, p.id === 'full')) };
}

// Crypto trend vs holding the coins, from when BTC has 200 days of history.
const cryStart = hist.dates[hist.closes.BTC.findIndex(v => v != null) + 202];
results.cryptoStart = cryStart;
results.crypto = { label: `${cryStart.slice(0, 4)}–now`, strategies: strip(score([
  { id: 'btc', name: 'BTC buy and hold', fn: buyAndHold('BTC'), note: 'Own bitcoin and do nothing.' },
  { id: 'cry', name: 'Crypto trend (BTC + ETH)', fn: cryptoTrend(), opts: { every: 5 }, note: 'Hold each coin only above its 200-day average; checked weekly; otherwise SHY. ETH joins once it has 200 days of history.' }
], cryStart, null, true)) };

// The combined fund: each quant runs in its own sleeve; sleeves rebalanced monthly.
const SLEEVES = { ROT: 0.60, MR: 0.20, CRY: 0.15 };
const sleeveRuns = score([
  { id: 'ROT', fn: momentumRotation(ROTATION_UNIVERSE, { topN: 3 }) },
  { id: 'MR', fn: meanReversion(ROTATION_UNIVERSE), opts: { every: 1 } },
  { id: 'CRY', fn: cryptoTrend(), opts: { every: 5 } },
  { id: 'SPY', fn: buyAndHold('SPY') }
], cryStart, null, false);
const sleeveHist = { dates: sleeveRuns[0]._equity.map(e => e.date), closes: Object.fromEntries(sleeveRuns.map(r => [r.id, r._equity.map(e => e.value)])) };
sleeveHist.closes.SHY = hist.closes.SHY.slice(hist.dates.indexOf(cryStart), hist.dates.indexOf(cryStart) + sleeveHist.dates.length);
const rfC = simulate(sleeveHist, buyAndHold('SHY'), { from: cryStart, costBps: 0 }).equity;
const combined = [
  { id: 'spy', name: 'SPY buy and hold', fn: buyAndHold('SPY') },
  { id: 'rot', name: 'Rotation alone (top 3)', fn: buyAndHold('ROT') },
  { id: 'desk', name: 'Combined desk: 60% rotation, 20% mean reversion, 15% crypto trend, 5% cash', fn: fixedMix(SLEEVES) },
  { id: 'nocry', name: 'Combined without crypto: 75% rotation, 20% mean reversion, 5% cash', fn: fixedMix({ ROT: 0.75, MR: 0.20 }) }
].map(s => { const r = simulate(sleeveHist, s.fn, { from: cryStart, costBps: COST }); return { id: s.id, name: s.name, ...metrics(r.equity, rfC), curve: thin(r.equity) }; });
results.combined = {
  label: `${cryStart.slice(0, 4)}–now`, sleeves: SLEEVES, strategies: combined,
  caution: 'Crypto rose roughly 300-fold over this window, and it was chosen for this desk in 2026, knowing that. Any mix holding crypto here is flattered by hindsight; compare it with the version without crypto.'
};

writeFileSync('state/backtest-etf.json', JSON.stringify(results));

const pct = v => (v * 100).toFixed(1).padStart(6) + '%';
for (const p of Object.values(results.periods)) {
  console.log(`\n${p.label}`);
  console.log('Strategy                              CAGR    Vol  Sharpe  Max DD  Worst yr   $10k ->');
  for (const s of p.strategies) console.log(`${s.name.padEnd(36)}${pct(s.cagr)}${pct(s.vol)}  ${s.sharpe.toFixed(2).padStart(5)} ${pct(s.maxDrawdown)}  ${s.worstYear?.year} ${pct(s.worstYear?.ret ?? 0)}  $${Math.round(s.growthOf10k).toLocaleString()}`);
}

const show = (title, list) => {
  console.log(`\n${title}`);
  console.log('Strategy                                                      CAGR    Vol  Sharpe  Max DD  Worst yr        $10k ->');
  for (const s of list) console.log(`${s.name.slice(0, 60).padEnd(60)}${pct(s.cagr)}${pct(s.vol)}  ${s.sharpe.toFixed(2).padStart(5)} ${pct(s.maxDrawdown)}  ${s.worstYear?.year} ${pct(s.worstYear?.ret ?? 0)}  $${Math.round(s.growthOf10k).toLocaleString()}`);
};
for (const p of Object.values(results.meanReversion)) show(`Mean reversion: ${p.label}`, p.strategies);
show(`Crypto trend: ${results.crypto.label}`, results.crypto.strategies);
show(`Combined desk: ${results.combined.label}`, results.combined.strategies);
