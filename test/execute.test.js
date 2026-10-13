import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitOrder } from '../src/core/execute.js';
import { createKillSwitch, memoryStore } from '../src/risk/killSwitch.js';
import { memoryLog } from '../src/core/auditLog.js';
import { createPaperBroker } from '../src/brokers/paper.js';
import { assertAdapter } from '../src/brokers/adapter.js';
import { samplePortfolio, buy, sell } from './fixtures.js';

function setup(opts = {}) {
  const snapshot = samplePortfolio();
  const broker = assertAdapter(createPaperBroker({ cash: snapshot.cash, positions: snapshot.positions, quotes: { NVDA: 138.40, INTC: 22.10 }, ...opts }));
  return { snapshot, broker, killSwitch: createKillSwitch(), log: memoryLog() };
}

test('approved order reaches the broker and is logged', async () => {
  const env = setup();
  const r = await submitOrder(buy('NVDA', 5, 138.40), { ...env, approvedBy: 'user' });
  assert.equal(r.status, 'filled');
  assert.equal((await env.broker.getPositions()).NVDA.qty, 5);
  assert.equal(env.log.entries.at(-1).kind, 'fill');
});

test('risk veto never reaches the broker', async () => {
  const env = setup();
  const r = await submitOrder(buy('NVDA', 30, 138.40), { ...env, approvedBy: 'user' });
  assert.equal(r.status, 'vetoed');
  assert.equal((await env.broker.getPositions()).NVDA, undefined);
  assert.equal(env.log.entries.at(-1).kind, 'veto');
});

test('halted kill switch blocks orders until resumed', async () => {
  const env = setup();
  env.killSwitch.halt('test');
  assert.equal((await submitOrder(sell('INTC', 10, 22.10), { ...env, approvedBy: 'user' })).status, 'vetoed');
  env.killSwitch.resume();
  assert.equal((await submitOrder(sell('INTC', 10, 22.10), { ...env, approvedBy: 'user' })).status, 'filled');
});

test('kill switch fails closed on unreadable state', () => {
  assert.equal(createKillSwitch(memoryStore({ garbage: true })).isHalted(), true);
  assert.equal(createKillSwitch(memoryStore(null)).isHalted(), false);
  assert.equal(createKillSwitch(memoryStore({ halted: false })).isHalted(), false);
});

test('orders without a recorded approval are refused', async () => {
  const env = setup();
  const r = await submitOrder(buy('NVDA', 1, 138.40), { ...env });
  assert.equal(r.status, 'vetoed');
});

test('read-only broker errors are caught and logged, not thrown', async () => {
  const env = setup({ readOnly: true });
  const r = await submitOrder(buy('NVDA', 1, 138.40), { ...env, approvedBy: 'user' });
  assert.equal(r.status, 'error');
  assert.equal(env.log.entries.at(-1).kind, 'error');
});

test('assertAdapter names missing methods', () => {
  assert.throws(() => assertAdapter({ getAccount() {} }, 'broken'), /broken is missing: getPositions/);
});
