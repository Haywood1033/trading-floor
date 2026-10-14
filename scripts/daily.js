// Daily run (GitHub Actions, after the US close): reads the Alpaca paper account and prices,
// runs the desk, and writes state/signals.json (call history) and state/feed.json (for the UI).
// Read-only: the broker adapter is created with readOnly: true and no order is ever sent.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createAlpacaBroker, snapshotFrom } from '../src/brokers/alpaca.js';
import { createTracker, fileSignalStore } from '../src/tracking/tracker.js';
import { runDesk, symbolsNeeded } from '../src/engine.js';

const broker = createAlpacaBroker({ readOnly: true });
const snapshot = await snapshotFrom(broker);
const prices = {};
const missing = [];
for (const s of symbolsNeeded(snapshot)) {
  try { prices[s] = await broker.getBars(s); } catch (e) { missing.push(`${s}: ${e.message}`); }
}

const tracker = createTracker(fileSignalStore('state/signals.json'));
const feed = await runDesk({
  snapshot, prices, tracker,
  closesAfter: (sym, date) => broker.closesAfter(sym, date),
  source: `${broker.name} (read-only)`
});
feed.missingPrices = missing;

mkdirSync('state', { recursive: true });
writeFileSync('state/feed.json', JSON.stringify(feed, null, 2));

const usd = v => '$' + Math.round(v).toLocaleString('en-US');
console.log(`${feed.source}: equity ${usd(feed.account.equity)}, cash ${usd(feed.account.cash)}, ${Object.keys(feed.positions).length} positions`);
for (const p of feed.proposals) {
  const status = p.risk.approved ? 'passes risk' + (p.resizedFrom ? ` (resized from ${p.resizedFrom})` : '') : 'BLOCKED: ' + p.risk.checks.filter(c => !c.ok).map(c => c.message).join(', ');
  console.log(`${p.quantId}  ${p.side.toUpperCase()} ${p.qty} ${p.symbol} @ ~$${p.price.toFixed(2)}  [${status}]${p.newCall ? '' : ' (already tracking)'}`);
  console.log(`     ${p.thesis}`);
}
console.log(`Graded today: ${feed.gradedToday.length}`);
for (const q of feed.scoreboard) console.log(`${q.name}: ${q.open} open, ${q.graded} graded, tier ${q.tier}`);
if (missing.length) console.log(`Missing prices:\n  ${missing.join('\n  ')}`);
