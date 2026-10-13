import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMomentum, momentumScore } from '../src/quants/momentum.js';
import { evaluateOrder } from '../src/risk/riskManager.js';
import { sampleBars, samplePortfolio } from '../src/data/sample.js';

const line = (start, end, n = 260) => Array.from({ length: n }, (_, i) => start + (end - start) * i / (n - 1));
const snap = (positions = {}, cash = 100000) => ({ cash, positions, startOfDayEquity: cash });

test('12-1 score skips the most recent month', () => {
  // Doubles over the year, then crashes in the last month: momentum still sees the climb.
  const closes = [...line(100, 200, 240), ...line(200, 120, 21)];
  assert.ok(momentumScore(closes) > 0.9);
  assert.equal(momentumScore(line(1, 2, 200)), null);
});

test('buys the strongest names that are above their 200-day average', () => {
  const bars = { A: line(100, 200), B: line(100, 150), C: line(100, 120), D: line(200, 100) };
  const { ranked, proposals } = runMomentum(snap(), bars, { universe: ['A', 'B', 'C', 'D'], topN: 2 });
  assert.deepEqual(proposals.map(p => p.symbol), ['A', 'B']);
  assert.equal(ranked.find(r => r.symbol === 'D').eligible, false);
  assert.match(proposals[0].thesis, /#1 of 4/);
});

test('sizes to the target weight and tops up existing positions', () => {
  const bars = { A: line(50, 100) };
  const fresh = runMomentum(snap(), bars, { universe: ['A'], targetWeight: 0.05 }).proposals[0];
  assert.equal(fresh.qty, 50); // 5% of $100k at $100
  const s = snap({ A: { qty: 30, price: 100, sector: 'Tech', assetClass: 'stock' } }, 97000);
  assert.equal(runMomentum(s, bars, { universe: ['A'], targetWeight: 0.05 }).proposals[0].qty, 20);
  const full = snap({ A: { qty: 50, price: 100, sector: 'Tech', assetClass: 'stock' } }, 95000);
  assert.equal(runMomentum(full, bars, { universe: ['A'] }).proposals.length, 0);
});

test('weak or short-history names are not bought', () => {
  const bars = { FLAT: line(100, 105), SHORT: line(100, 200, 100) };
  const { ranked, proposals } = runMomentum(snap(), bars, { universe: ['FLAT', 'SHORT'] });
  assert.equal(proposals.length, 0);
  assert.match(ranked.find(r => r.symbol === 'SHORT').why, /history/);
});

test('on the sample portfolio every proposal passes risk on its own', () => {
  const s = samplePortfolio();
  const { proposals } = runMomentum(s, sampleBars());
  assert.ok(proposals.length > 0);
  for (const p of proposals) assert.equal(evaluateOrder(p, s).approved, true, p.symbol);
});
