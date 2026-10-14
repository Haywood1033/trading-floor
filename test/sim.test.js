import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, step, openNextDay, closesAfter, nextBusinessDay, clockLabel, TICKS_PER_DAY } from '../app/sim.js';
import { sampleBars } from '../src/data/sample.js';

const fresh = (seed) => createSim({ bars: sampleBars(), startDate: '2026-10-14', seed });

test('business days skip weekends', () => {
  assert.equal(nextBusinessDay('2026-10-16'), '2026-10-19'); // Fri -> Mon
  assert.equal(nextBusinessDay('2026-10-14'), '2026-10-15');
});

test('history dates end the business day before the start', () => {
  const sim = fresh();
  assert.equal(sim.dates.at(-1), '2026-10-13');
  assert.equal(sim.dates.length, sim.history.SPY.length);
});

test('a session runs 9:30 to 4:00 and then rolls to the next day', () => {
  const sim = fresh();
  assert.equal(clockLabel(sim), '9:30 AM');
  let closed = false;
  for (let i = 0; i < TICKS_PER_DAY; i++) closed = step(sim).closed;
  assert.equal(closed, true);
  assert.equal(clockLabel(sim), '4:00 PM');
  assert.equal(step(sim).closed, false); // no ticks after the close
  const before = sim.history.SPY.length;
  openNextDay(sim);
  assert.equal(sim.history.SPY.length, before + 1);
  assert.equal(sim.day, '2026-10-15');
  assert.equal(sim.tick, 0);
  assert.deepEqual(closesAfter(sim, 'SPY', '2026-10-13'), [sim.history.SPY.at(-1)]);
});

test('same seed, same market; prices stay positive and plausible over a year', () => {
  const a = fresh(7), b = fresh(7);
  for (let d = 0; d < 252; d++) {
    for (let i = 0; i < TICKS_PER_DAY; i++) { step(a); step(b); }
    openNextDay(a); openNextDay(b);
  }
  assert.deepEqual(a.prices, b.prices);
  for (const [s, p] of Object.entries(a.prices)) {
    const start = sampleBars()[s].at(-1);
    assert.ok(p > 0 && p / start < 20 && p / start > 0.05, `${s} went ${start} -> ${p}`);
  }
  assert.ok(a.history.SPY.length <= 400);
});

test('state survives a JSON round trip (as in localStorage)', () => {
  const a = fresh(3);
  for (let i = 0; i < 10; i++) step(a);
  const b = JSON.parse(JSON.stringify(a));
  step(a); step(b);
  assert.deepEqual(a.prices, b.prices);
});
