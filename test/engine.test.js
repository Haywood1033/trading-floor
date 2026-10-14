import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDesk } from '../src/engine.js';
import { createTracker, memorySignalStore } from '../src/tracking/tracker.js';
import { sampleBars, samplePortfolio } from '../src/data/sample.js';

test('a desk run returns a complete feed and records each call once', async () => {
  const tracker = createTracker(memorySignalStore());
  const args = { snapshot: samplePortfolio(), prices: sampleBars(), tracker, source: 'test', now: new Date('2026-10-14T21:30:00Z') };
  const feed = await runDesk(args);
  assert.ok(feed.proposals.length >= 10);
  assert.ok(feed.proposals.every(p => p.newCall && p.risk));
  assert.deepEqual(feed.scoreboard.map(q => q.quantId).sort(), ['mom', 'rev']);
  assert.equal(feed.account.cash, 4700);
  const again = await runDesk({ ...args, snapshot: samplePortfolio() });
  assert.ok(again.proposals.every(p => !p.newCall));
  assert.equal(tracker.all().length, feed.proposals.length);
});

test('an empty account gets momentum buys and no reviewer calls', async () => {
  const tracker = createTracker(memorySignalStore());
  const snapshot = { cash: 100000, positions: {}, startOfDayEquity: 100000 };
  const feed = await runDesk({ snapshot, prices: sampleBars(), tracker, source: 'test' });
  assert.ok(feed.proposals.length > 0);
  assert.ok(feed.proposals.every(p => p.quantId === 'mom' && p.side === 'buy' && p.risk.approved));
});
