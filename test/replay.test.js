import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplay, step, openNextDay, closesAfter, attach, earliestStart } from '../app/replay.js';
import { TICKS_PER_DAY } from '../app/sim.js';
import { synthHist } from './helpers.js';

test('starts at the chosen date with yesterday\'s real closes, after a warmup', () => {
  const h = synthHist();
  const sim = createReplay(h, { startDate: h.dates[300] });
  assert.equal(sim.day, h.dates[300]);
  assert.equal(sim.prices.SPY, h.closes.SPY[299]);
  assert.equal(sim.history.SPY.length, 300);
  assert.equal(sim.history.SPY.at(-1), h.closes.SPY[299]);
  assert.equal(createReplay(h, { startDate: h.dates[5] }).day, earliestStart(h));   // pushed to the warmup
});

test('each day ends exactly on the real close, then rolls to the next real date', () => {
  const h = synthHist();
  const sim = createReplay(h, { startDate: h.dates[300] });
  let closed = false;
  for (let k = 0; k < TICKS_PER_DAY; k++) closed = step(sim).closed;
  assert.equal(closed, true);
  for (const s of ['SPY', 'XLK', 'TLT']) assert.ok(Math.abs(sim.prices[s] - h.closes[s][300]) < 1e-6, s);
  openNextDay(sim);
  assert.equal(sim.day, h.dates[301]);
  assert.equal(sim.history.SPY.at(-1), h.closes.SPY[300]);
  assert.deepEqual(closesAfter(sim, 'SPY', h.dates[299]), [h.closes.SPY[300]]);   // nothing from the future
});

test('the quants never see the future', () => {
  const h = synthHist();
  const sim = createReplay(h, { startDate: h.dates[300] });
  for (const arr of Object.values(sim.history)) assert.ok(arr.length <= 300);
  assert.equal(closesAfter(sim, 'SPY', h.dates[0]).length, 299);
});

test('history, dates and paths are not saved with the fund', () => {
  const h = synthHist();
  const sim = createReplay(h, { startDate: h.dates[300] });
  step(sim);
  const saved = JSON.parse(JSON.stringify(sim));
  assert.equal(saved.history, undefined); assert.equal(saved.hist, undefined); assert.equal(saved.dates, undefined);
  assert.ok(JSON.stringify(sim).length < 2000);
  attach(saved, h);
  step(saved); step(sim);
  assert.deepEqual(saved.prices, sim.prices);                                        // same path after reload
});

test('funds that do not exist yet have no price until they list', () => {
  const h = synthHist(400, { SPY: 0.0004, NEW: 0.001 }, { NEW: 350 });
  const sim = createReplay(h, { startDate: h.dates[300] });
  assert.equal(sim.prices.NEW, undefined);
  assert.equal(sim.history.NEW, undefined);
});

test('the replay ends when the data runs out', () => {
  const h = synthHist(300);
  const sim = createReplay(h, { startDate: h.dates[299] });
  for (let k = 0; k < TICKS_PER_DAY; k++) step(sim);
  openNextDay(sim);
  assert.equal(sim.ended, true);
  assert.equal(step(sim).closed, false);
});
