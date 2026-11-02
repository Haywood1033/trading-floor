import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rsi } from '../src/quants/indicators.js';
import { mrSignals } from '../src/quants/meanReversion.js';
import { cryptoSignals } from '../src/quants/cryptoTrend.js';

const up = (n, a = 100, step = 0.3) => Array.from({ length: n }, (_, i) => a + i * step);

test('RSI(2): all gains is 100, all losses 0, mixed in between', () => {
  assert.equal(rsi(up(30)), 100);
  assert.equal(rsi(up(30, 200, -1)), 0);
  const r = rsi([...up(30), 110, 105, 100]);
  assert.ok(r < 10, `sharp 2-day drop gives low RSI(2): ${r}`);
  assert.equal(rsi([1, 2]), null);
});

test('mean reversion buys a sharp dip in an uptrend, not a falling fund', () => {
  const dip = [...up(250), 170, 166, 163];            // uptrend, then 3 down days
  const falling = [...up(250, 300, -0.3), 220, 216, 213]; // downtrend with the same dip
  const { entries } = mrSignals({ DIP: dip, FALL: falling }, ['DIP', 'FALL']);
  assert.deepEqual(entries.map(e => e.symbol), ['DIP']);
  assert.match(entries[0].why, /RSI\(2\)/);
});

test('mean reversion exits on the bounce or after 10 days, and respects 3 slots', () => {
  const bounced = [...up(250), 170, 166, 175];
  const stuck = [...up(250), 170, 166, 163, 162, 161];
  const { exits } = mrSignals({ A: bounced, B: stuck }, [], { A: 2, B: 10 });
  assert.deepEqual(exits.map(e => e.symbol).sort(), ['A', 'B']);
  assert.match(exits.find(e => e.symbol === 'A').why, /5-day average/);
  assert.match(exits.find(e => e.symbol === 'B').why, /time stop/);
  const dips = Object.fromEntries(['P', 'Q', 'R', 'S', 'T'].map((s, i) => [s, [...up(250), 170, 166 - i, 163 - i * 2]]));
  const r = mrSignals({ ...dips, H: stuck }, Object.keys(dips), { H: 3 });
  assert.equal(r.entries.length, 2);                   // 3 slots, 1 held
  assert.ok(r.entries[0].rsi <= r.entries[1].rsi);     // most oversold first
});

test('crypto trend holds only coins above their 200-day average', () => {
  const r = cryptoSignals({ BTC: up(260), ETH: up(260, 400, -0.5) });
  assert.deepEqual(r.want, ['BTC']);
  assert.equal(cryptoSignals({ BTC: up(100) }).scan[0].above, null);   // not enough history
});
