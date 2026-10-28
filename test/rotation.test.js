import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRotation, rankUniverse } from '../src/quants/rotation.js';

const line = (a, b, n = 300) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
const bars = { A: line(100, 200), B: line(100, 160), C: line(100, 130), D: line(100, 105), E: line(200, 100) };
const U = ['A', 'B', 'C', 'D', 'E'];
const snap = (positions = {}, cash = 10000) => ({ cash, positions, startOfDayEquity: cash });

test('ranks by 12-1 return and filters weak or falling funds', () => {
  const r = rankUniverse(bars, U);
  assert.deepEqual(r.map(x => x.symbol), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(r.find(x => x.symbol === 'E').ok, false);
});

test('from cash: buys the top 3 to equal shares, leaving a cash buffer', () => {
  const { picks, proposals } = runRotation(snap(), bars, { universe: U });
  assert.deepEqual(picks, ['A', 'B', 'C']);
  assert.ok(proposals.every(p => p.side === 'buy'));
  for (const p of proposals) assert.ok(Math.abs(p.qty * p.price - 10000 * 0.95 / 3) < 1);
});

test('sells funds that left the top 3 first, and leaves on-target picks alone', () => {
  const positions = {
    A: { qty: 3166.6 / 200, price: 200, assetClass: 'etf' },
    E: { qty: 20, price: 100, assetClass: 'etf' }
  };
  const held = { A: positions.A.qty, E: 20 };
  const { proposals } = runRotation(snap(positions, 4000), bars, { universe: U, held });
  assert.equal(proposals[0].side, 'sell');
  assert.equal(proposals[0].symbol, 'E');
  assert.match(proposals[0].thesis, /below its 200-day|negative/);
  assert.ok(!proposals.some(p => p.symbol === 'A'));          // already at target
  assert.ok(proposals.some(p => p.symbol === 'B' && p.side === 'buy'));
});

test('fewer than 3 qualifiers: the empty slot stays in cash', () => {
  const weak = { A: line(100, 200), E: line(200, 100), F: line(150, 100) };
  const { picks, proposals } = runRotation(snap(), weak, { universe: ['A', 'E', 'F'] });
  assert.deepEqual(picks, ['A']);
  assert.equal(proposals.length, 1);
});
