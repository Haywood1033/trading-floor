import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplay, advance, closesAfter, attach, earliestStart, dividendsToday } from '../app/replay.js';
import { synthHist } from './helpers.js';

test('starts at the close of the chosen date, after a warmup', () => {
  const h = synthHist();
  const sim = createReplay(h, { startDate: h.dates[300] });
  assert.equal(sim.day, h.dates[300]);
  assert.equal(sim.prices.SPY, h.closes.SPY[300]);
  assert.equal(sim.prevClose.SPY, h.closes.SPY[299]);
  assert.equal(sim.history.SPY.length, 301);              // up to and including the start close
  assert.equal(createReplay(h, { startDate: h.dates[5] }).day, earliestStart(h));
});

test('each step moves to the next real close', () => {
  const h = synthHist();
  const sim = createReplay(h, { startDate: h.dates[300] });
  assert.equal(advance(sim), true);
  assert.equal(sim.day, h.dates[301]);
  for (const s of ['SPY', 'XLK', 'TLT']) assert.equal(sim.prices[s], h.closes[s][301]);
  assert.equal(sim.history.SPY.at(-1), h.closes.SPY[301]);
  assert.deepEqual(closesAfter(sim, 'SPY', h.dates[300]), [h.closes.SPY[301]]);
});

test('the quants never see past the current close', () => {
  const h = synthHist();
  const sim = createReplay(h, { startDate: h.dates[300] });
  for (const arr of Object.values(sim.history)) assert.ok(arr.length <= 301);
  assert.equal(closesAfter(sim, 'SPY', h.dates[0]).length, 300);
});

test('history is not saved with the fund, and reattaches the same', () => {
  const h = synthHist();
  const sim = createReplay(h, { startDate: h.dates[300] });
  advance(sim);
  const saved = JSON.parse(JSON.stringify(sim));
  assert.equal(saved.history, undefined); assert.equal(saved.hist, undefined); assert.equal(saved.dates, undefined);
  assert.ok(JSON.stringify(sim).length < 2000);
  attach(saved, h);
  assert.deepEqual(saved.prices, sim.prices);
  advance(saved); advance(sim);
  assert.deepEqual(saved.prices, sim.prices);
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
  assert.equal(advance(sim), false);
  assert.equal(sim.ended, true);
});

test('dividends and total-return grading', () => {
  const h = synthHist();
  h.divs = { TLT: { 302: 1 } };
  h.tr = { ...h.closes, TLT: h.closes.TLT.map((v, i) => (i >= 302 ? v * (1 + 1 / h.closes.TLT[301]) : v)) };
  const sim = createReplay(h, { startDate: h.dates[300] });
  advance(sim);
  assert.deepEqual(dividendsToday(sim), {});
  advance(sim);
  assert.deepEqual(dividendsToday(sim), { TLT: 1 });
  const after = closesAfter(sim, 'TLT', h.dates[300]);
  assert.ok(Math.abs(after[1] / h.closes.TLT[300] - h.tr.TLT[302] / h.tr.TLT[300]) < 1e-12);
});
