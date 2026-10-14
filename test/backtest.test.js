import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, alignToBenchmark } from '../src/backtest.js';
import { parseChart, yahooSymbol } from '../src/data/yahoo.js';

// Synthetic history: n trading days of compounding daily returns.
function hist(n, daily, start = 100) {
  const out = []; let c = start;
  for (let i = 0; i < n; i++) {
    out.push({ date: new Date(Date.UTC(2015, 0, 1) + i * 864e5).toISOString().slice(0, 10), c });
    c *= 1 + (typeof daily === 'function' ? daily(i) : daily);
  }
  return out;
}

test('yahoo symbols and chart parsing', () => {
  assert.equal(yahooSymbol('BTC'), 'BTC-USD');
  assert.equal(yahooSymbol('BRK.B'), 'BRK-B');
  const rows = parseChart({ chart: { result: [{ timestamp: [1704153600, 1704240000, 1704326400],
    indicators: { adjclose: [{ adjclose: [100, null, 102] }] } }] } });
  assert.deepEqual(rows, [{ date: '2024-01-02', c: 100 }, { date: '2024-01-04', c: 102 }]);
  assert.throws(() => parseChart({ chart: { result: null, error: { description: 'Not Found' } } }), /Not Found/);
});

test('alignment carries the last known price over missing days', () => {
  const { closes } = alignToBenchmark({ SPY: hist(3, 0), X: [{ date: '2015-01-01', c: 5 }, { date: '2015-01-03', c: 7 }] });
  assert.deepEqual(closes.X, [5, 5, 7]);
});

test('momentum beats the baseline when winners keep winning, and the reviewer catches losers', () => {
  const n = 900;
  const history = {
    SPY: hist(n, 0.0003),
    UP1: hist(n, 0.0012), UP2: hist(n, 0.0010), UP3: hist(n, 0.0009),
    FLAT1: hist(n, 0.0001), FLAT2: hist(n, 0.0),
    DOWN1: hist(n, -0.0008), DOWN2: hist(n, -0.0010)
  };
  const r = runBacktest(history, { universe: ['UP1', 'UP2', 'UP3', 'FLAT1', 'FLAT2', 'DOWN1', 'DOWN2'] });
  assert.ok(r.momentum.n > 20);
  assert.equal(r.momentum.hitRate, 1);                          // only ever buys the persistent winners
  assert.ok(r.momentum.avgExcess > r.baselineBuyEverything.avgExcess);
  assert.ok(r.reviewer.n > 0 && r.reviewer.hitRate === 1);      // sells only the persistent losers
  assert.ok(r.caveats.some(c => /Survivorship/.test(c)));
});

test('no look-ahead: a stock that only rallies after a call date is not picked before it', () => {
  const n = 700;
  const late = hist(n, i => (i < 500 ? -0.0005 : 0.004));
  const r = runBacktest({ SPY: hist(n, 0.0002), LATE: late, STEADY: hist(n, 0.0008) }, { universe: ['LATE', 'STEADY'] });
  const early = r.recentCalls.momentum.concat([]).filter(c => c.symbol === 'LATE' && c.date < late[500].date);
  assert.equal(early.length, 0);
});
