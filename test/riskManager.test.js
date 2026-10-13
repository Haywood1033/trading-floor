import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOrder, canAutoExecute, maxQtyWithinLimits } from '../src/risk/riskManager.js';
import { summarize } from '../src/core/portfolio.js';
import { samplePortfolio, buy, sell } from './fixtures.js';

const failed = r => r.checks.filter(c => !c.ok).map(c => c.id);

test('sample portfolio is about $24k', () => {
  const s = summarize(samplePortfolio());
  assert.ok(s.equity > 23000 && s.equity < 25000, `equity ${s.equity}`);
});

test('a modest buy passes every check', () => {
  const r = evaluateOrder(buy('NVDA', 5, 138.40), samplePortfolio());
  assert.equal(r.approved, true, JSON.stringify(failed(r)));
});

test('a buy that pushes one stock past 10% is blocked', () => {
  const r = evaluateOrder(buy('TSLA', 12, 251, { sector: 'Auto' }), samplePortfolio());
  assert.equal(r.approved, false);
  assert.deepEqual(failed(r), ['positionSize']);
});

test('resize finds the largest size that fits', () => {
  const snap = samplePortfolio();
  const order = buy('TSLA', 12, 251, { sector: 'Auto' });
  const q = maxQtyWithinLimits(order, snap);
  assert.ok(q > 0 && q < 12);
  assert.equal(evaluateOrder({ ...order, qty: q }, snap).approved, true);
  assert.equal(evaluateOrder({ ...order, qty: q + 1 }, snap).approved, false);
});

test('sector cap blocks a tech buy that takes tech over 40%', () => {
  // Tech is ~23% now; 25 NVDA takes it to ~37.5%. Raise the per-name cap so only the sector cap can bite.
  const r = evaluateOrder(buy('NVDA', 25, 138.40), samplePortfolio(), { limits: { maxPositionPct: 1, minCashPct: 0, maxOrderValue: 1e9 } });
  assert.equal(r.approved, true);
  const snap = samplePortfolio();
  snap.cash = 20000; snap.startOfDayEquity += 15300;
  const r2 = evaluateOrder(buy('NVDA', 120, 138.40), snap, { limits: { maxPositionPct: 1, minCashPct: 0, maxOrderValue: 1e9 } });
  assert.ok(failed(r2).includes('sectorExposure'));
});

test('crypto buys are capped at 20% combined', () => {
  const r = evaluateOrder(buy('BTC', 0.02, 63800, { sector: 'Crypto', assetClass: 'crypto' }), samplePortfolio());
  assert.ok(failed(r).includes('cryptoExposure'));
  const ok = evaluateOrder(buy('SOL', 1, 148, { sector: 'Crypto', assetClass: 'crypto' }), samplePortfolio());
  assert.equal(ok.approved, true);
});

test('cash floor blocks buys that would drain cash below 5%', () => {
  const snap = samplePortfolio();
  snap.cash = 1500; snap.startOfDayEquity -= 3200;
  const r = evaluateOrder(buy('NVDA', 9, 138.40), snap);
  assert.ok(failed(r).includes('cashFloor'));
});

test('daily loss cap blocks buys but not sells', () => {
  const snap = samplePortfolio();
  snap.startOfDayEquity *= 1.03; // account is down ~3% today
  assert.ok(failed(evaluateOrder(buy('NVDA', 1, 138.40), snap)).includes('dailyLoss'));
  assert.equal(evaluateOrder(sell('INTC', 95, 22.10), snap).approved, true);
});

test('cannot sell more than you hold (no shorting)', () => {
  const r = evaluateOrder(sell('INTC', 96, 22.10), samplePortfolio());
  assert.deepEqual(failed(r), ['noShort']);
  assert.equal(evaluateOrder(sell('NVDA', 1, 138), samplePortfolio()).approved, false);
});

test('kill switch blocks everything, sells included', () => {
  const r = evaluateOrder(sell('INTC', 10, 22.10), samplePortfolio(), { halted: true });
  assert.deepEqual(failed(r), ['halted']);
});

test('malformed orders are rejected', () => {
  for (const bad of [buy('NVDA', 0, 138), buy('NVDA', 1, 0), buy('NVDA', -1, 138), { symbol: 'X', side: 'short', qty: 1, price: 1 }]) {
    assert.equal(evaluateOrder(bad, samplePortfolio()).approved, false);
  }
});

test('order value cap applies even to sells', () => {
  const r = evaluateOrder(sell('INTC', 95, 22.10), samplePortfolio(), { limits: { maxOrderValue: 1000 } });
  assert.deepEqual(failed(r), ['maxOrderValue']);
});

test('day-trade cap applies under the equity threshold only', () => {
  const o = buy('NVDA', 1, 138.40);
  assert.ok(failed(evaluateOrder(o, samplePortfolio(), { opensDayTrade: true, dayTradesUsed: 3 })).includes('dayTrades'));
  assert.equal(evaluateOrder(o, samplePortfolio(), { opensDayTrade: true, dayTradesUsed: 2 }).approved, true);
  assert.equal(evaluateOrder(o, samplePortfolio(), { opensDayTrade: true, dayTradesUsed: 3, limits: { dayTradeEquityThreshold: 10000 } }).approved, true);
  assert.equal(evaluateOrder(o, samplePortfolio(), { opensDayTrade: true, dayTradesUsed: 9, limits: { dayTradeLimit: null } }).approved, true);
});

test('auto mode needs auto on, a cleared tier and a small order', () => {
  const snap = samplePortfolio();
  const small = buy('NVDA', 5, 138.40);
  assert.equal(canAutoExecute(small, snap, { mode: 'auto', quantTier: 'elite' }).auto, true);
  assert.equal(canAutoExecute(small, snap, { mode: 'approval', quantTier: 'elite' }).auto, false);
  assert.equal(canAutoExecute(small, snap, { mode: 'auto', quantTier: 'unproven' }).auto, false);
  assert.equal(canAutoExecute(buy('NVDA', 15, 138.40), snap, { mode: 'auto', quantTier: 'elite' }).auto, false);
  assert.equal(canAutoExecute(small, snap, { mode: 'auto', quantTier: 'elite', halted: true }).auto, false);
});

test('evaluation is pure: the snapshot is not mutated', () => {
  const snap = samplePortfolio();
  const before = JSON.stringify(snap);
  evaluateOrder(buy('NVDA', 5, 138.40), snap);
  evaluateOrder(sell('INTC', 95, 22.10), snap);
  assert.equal(JSON.stringify(snap), before);
});
