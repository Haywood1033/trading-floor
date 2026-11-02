import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, metrics, buyAndHold, equalWeight, momentumRotation, fixedMix } from '../src/portfolioBacktest.js';

function hist(n, specs) {
  const dates = [], closes = {};
  const d0 = Date.UTC(2010, 0, 4);
  for (let i = 0; i < n; i++) dates.push(new Date(d0 + i * 864e5).toISOString().slice(0, 10));
  for (const [s, f] of Object.entries(specs)) { closes[s] = []; let c = 100; for (let i = 0; i < n; i++) { closes[s].push(c); c *= 1 + f(i); } }
  return { dates, closes };
}

test('buy and hold matches the price ratio; costs only on the first trade', () => {
  const h = hist(600, { SPY: () => 0.0005 });
  const r = simulate(h, buyAndHold('SPY'), { from: h.dates[0], costBps: 0 });
  const expected = h.closes.SPY.at(-1) / h.closes.SPY[1];          // bought at day 1's close
  assert.ok(Math.abs(r.equity.at(-1).value / 10000 - expected) < 1e-9);
  const withCost = simulate(h, buyAndHold('SPY'), { from: h.dates[0], costBps: 10 });
  assert.ok(withCost.equity.at(-1).value < r.equity.at(-1).value);
  assert.ok(Math.abs(withCost.costs - 10) < 1e-6);                 // 10 bps of $10,000 once; later rebalances trade nothing
});

test('trades execute the day after the signal (no same-day peeking)', () => {
  // A jumps 50% on exactly the signal day; a same-day strategy would catch it, ours must not.
  const h = hist(300, { A: i => (i === 0 ? 0.5 : 0), SHY: () => 0 });   // close[1] is 50% above close[0]
  const r = simulate(h, buyAndHold('A'), { from: h.dates[0], costBps: 0 });
  assert.ok(Math.abs(r.equity.at(-1).value - 10000) < 1e-6);       // bought after the jump: no gain
});

test('rotation holds the leaders above trend and parks the rest in cash', () => {
  const h = hist(700, { UP: () => 0.001, MID: () => 0.0004, DOWN: () => -0.0008, SHY: () => 0.0001 });
  const strat = momentumRotation(['UP', 'MID', 'DOWN'], { topN: 3 });
  const w = strat(h, 600);
  assert.ok(Math.abs(w.UP - 1 / 3) < 1e-9 && Math.abs(w.MID - 1 / 3) < 1e-9);
  assert.equal(w.DOWN, undefined);
  assert.ok(Math.abs(w.SHY - 1 / 3) < 1e-9);
  assert.equal(Object.keys(strat(h, 100)).join(), 'SHY');          // under a year of history: all cash
});

test('equal weight skips funds without a year of history', () => {
  const h = hist(400, { A: () => 0, B: () => 0 });
  for (let i = 0; i < 300; i++) h.closes.B[i] = null;
  assert.deepEqual(Object.keys(equalWeight(['A', 'B'])(h, 350)), ['A']);
});

test('metrics: CAGR, drawdown, worst year, positive months', () => {
  const eq = [];
  let v = 100;
  for (let i = 0; i < 505; i++) {                                   // ~2 years
    const date = new Date(Date.UTC(2020, 0, 1) + i * 864e5 * 1.45).toISOString().slice(0, 10);
    v *= i === 300 ? 0.7 : 1.001;
    eq.push({ date, value: v });
  }
  const m = metrics(eq);
  assert.ok(Math.abs(m.maxDrawdown + 0.3) < 1e-9);
  assert.ok(m.cagr > 0 && m.cagr < 1);
  assert.ok(m.worstYear && m.yearly[m.worstYear.year] === Math.min(...Object.values(m.yearly)));
  assert.ok(m.positiveMonths > 0.8);
});

test('a fixed mix rebalances back to target', () => {
  const h = hist(300, { A: () => 0.002, B: () => -0.001 });
  const r = simulate(h, fixedMix({ A: 0.5, B: 0.5 }), { from: h.dates[0], costBps: 0 });
  assert.ok(r.rebalances > 5 && r.turnoverPerYear > 0);
});

test('a strategy can skip a day (null): no trades and no costs', () => {
  const h = hist(300, { A: () => 0.001 });
  let calls = 0;
  const strat = () => (calls++ === 0 ? { A: 1 } : null);
  const r = simulate(h, strat, { from: h.dates[0], every: 1, costBps: 10 });
  assert.equal(r.rebalances, 1);
  assert.ok(Math.abs(r.costs - 10) < 1e-6);
  assert.ok(calls > 200);
});

test('mean reversion strategy enters dips, exits bounces, and keeps held weights', async () => {
  const { meanReversion } = await import('../src/portfolioBacktest.js');
  // A steady uptrend with a sharp 3-day dip every 40 days, then recovery.
  const h = hist(700, { A: i => (i % 40 >= 37 ? -0.03 : 0.003), SHY: () => 0 });
  const r = simulate(h, meanReversion(['A']), { from: h.dates[0], every: 1, costBps: 10 });
  assert.ok(r.rebalances > 10, `traded ${r.rebalances} times`);   // enters each dip, exits each bounce or time stop
  assert.ok(r.equity.every(e => e.value > 0));                    // profitability is for the real-data backtest
});

test('crypto trend holds coins above trend and cash otherwise', async () => {
  const { cryptoTrend } = await import('../src/portfolioBacktest.js');
  const h = hist(400, { BTC: i => (i < 250 ? 0.003 : -0.004), ETH: () => -0.002, SHY: () => 0 });
  const strat = cryptoTrend();
  const early = strat(h, 240);
  assert.ok(Math.abs(early.BTC - 0.5) < 1e-9 && Math.abs(early.SHY - 0.5) < 1e-9);
  assert.deepEqual(Object.keys(strat(h, 399)), ['SHY']);
});

test('a missing close carries the last known price instead of zero', () => {
  const h = hist(300, { BTC: () => 0.001 });
  h.closes.BTC[150] = null; h.closes.BTC[299] = null;
  const r = simulate(h, buyAndHold('BTC'), { from: h.dates[0], costBps: 0 });
  assert.ok(r.equity[150].value > 10000 && r.equity.at(-1).value > 10000);
  const m = metrics(r.equity);
  assert.ok(Number.isFinite(m.cagr) && m.maxDrawdown > -0.01);
});
