import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, memorySignalStore, gradeSignal } from '../src/tracking/tracker.js';
import { wilsonLower, tierFor } from '../src/tracking/stats.js';

const prop = (symbol, side, price = 100, quantId = 'mom') => ({ quantId, symbol, side, price, assetClass: 'stock', confidence: 0.55, thesis: 't' });
const flat = (v, n) => Array(n).fill(v);

test('records a call once while it is open', () => {
  const t = createTracker(memorySignalStore());
  assert.equal(t.record(prop('NVDA', 'buy'), { benchmark: 'SPY', benchEntry: 500 }).recorded, true);
  assert.equal(t.record(prop('NVDA', 'buy'), { benchmark: 'SPY', benchEntry: 500 }).recorded, false);
  assert.equal(t.record(prop('NVDA', 'sell'), { benchmark: 'SPY', benchEntry: 500 }).recorded, true);
  assert.equal(t.record(prop('NVDA', 'buy', 100, 'rev'), { benchmark: 'SPY', benchEntry: 500 }).recorded, true);
  assert.equal(t.all().length, 3);
});

test('a buy is right when the stock beats the benchmark', () => {
  const s = { side: 'buy', entryPrice: 100, benchEntry: 500, horizonDays: 3 };
  const r = gradeSignal(s, [101, 103, 110], [505, 510, 520]); // +10% vs +4%
  assert.equal(r.correct, true);
  assert.ok(Math.abs(r.excess - 0.06) < 1e-9);
  assert.equal(gradeSignal(s, [101, 102, 103], [505, 510, 550]).correct, false); // +3% vs +10%
});

test('a sell is right when the stock trails the benchmark, even if both rose', () => {
  const s = { side: 'sell', entryPrice: 100, benchEntry: 500, horizonDays: 2 };
  assert.equal(gradeSignal(s, [101, 102], [520, 540]).correct, true);  // +2% vs +8%: good sell
  assert.equal(gradeSignal(s, [110, 120], [505, 510]).correct, false); // +20% vs +2%: bad sell
});

test('not graded before the horizon passes', () => {
  const s = { side: 'buy', entryPrice: 100, benchEntry: 500, horizonDays: 63 };
  assert.equal(gradeSignal(s, flat(120, 62), flat(500, 62)), null);
  assert.notEqual(gradeSignal(s, flat(120, 63), flat(500, 63)), null);
});

test('gradeOpen grades due calls, leaves the rest open, and feeds the scoreboard', async () => {
  const t = createTracker(memorySignalStore());
  t.record(prop('WIN', 'buy'), { benchmark: 'SPY', benchEntry: 100, issuedOn: '2026-01-02', horizonDays: 2 });
  t.record(prop('LOSE', 'buy'), { benchmark: 'SPY', benchEntry: 100, issuedOn: '2026-01-02', horizonDays: 2 });
  t.record(prop('NEW', 'buy'), { benchmark: 'SPY', benchEntry: 100, issuedOn: '2026-03-01', horizonDays: 2 });
  const prices = { WIN: [105, 120], LOSE: [99, 95], NEW: [101], SPY: [101, 105] };
  const graded = await t.gradeOpen(async (sym, date) => sym === 'SPY' && date === '2026-03-01' ? [101] : prices[sym]);
  assert.deepEqual(graded.map(s => s.symbol).sort(), ['LOSE', 'WIN']);
  const [mom] = t.scoreboard();
  assert.deepEqual([mom.open, mom.graded, mom.hits, mom.tier], [1, 2, 1, 'unproven']);
});

test('wilson lower bound is cautious with small samples', () => {
  assert.ok(wilsonLower(6, 8) < 0.5);       // 75% on 8 calls proves little
  assert.ok(wilsonLower(150, 200) > 0.69);  // 75% on 200 calls is solid
  assert.equal(wilsonLower(0, 0), 0);
});

test('tiers need enough graded calls and a real edge', () => {
  assert.equal(tierFor({ n: 19, hits: 19, avgExcess: 0.1 }), 'unproven');
  assert.equal(tierFor({ n: 200, hits: 130, avgExcess: 0.02 }), 'elite');    // 65%
  assert.equal(tierFor({ n: 200, hits: 112, avgExcess: 0.01 }), 'allstar');  // 56%
  assert.equal(tierFor({ n: 40, hits: 22, avgExcess: 0.01 }), 'value');      // 55%, unproven bound
  assert.equal(tierFor({ n: 40, hits: 22, avgExcess: -0.01 }), 'unproven');  // wins small, loses big
  assert.equal(tierFor({ n: 200, hits: 90, avgExcess: 0 }), 'unproven');
});
