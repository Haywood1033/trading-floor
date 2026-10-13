// Grades open calls whose horizon has passed, then prints each quant's record and tier.
//   npm run grade              data/sample-signals.json (no prices to grade against yet)
//   npm run grade -- --alpaca  data/signals.json, graded with real Alpaca prices

import { createTracker, fileSignalStore } from '../src/tracking/tracker.js';
import { MIN_GRADED } from '../src/tracking/stats.js';

const useAlpaca = process.argv.includes('--alpaca');
const tracker = createTracker(fileSignalStore(useAlpaca ? 'data/signals.json' : 'data/sample-signals.json'));

if (useAlpaca) {
  const { createAlpacaBroker } = await import('../src/brokers/alpaca.js');
  const broker = createAlpacaBroker({ readOnly: true });
  const graded = await tracker.gradeOpen((sym, date) => broker.closesAfter(sym, date));
  console.log(`Graded ${graded.length} call${graded.length === 1 ? '' : 's'} today.\n`);
} else {
  console.log('Sample mode: sample prices have no future, so nothing can be graded yet.\n');
}

const NAMES = { rev: 'Portfolio reviewer', mom: 'Momentum' };
const pct = v => v == null ? '  -  ' : (v * 100).toFixed(1) + '%';
const board = tracker.scoreboard();
if (!board.length) console.log('No calls recorded yet. Run `npm run quants` first.');
console.log('Quant                Open  Graded  Hit rate  Lower bound  Avg vs benchmark  Tier');
for (const q of board) {
  console.log(`${(NAMES[q.quantId] || q.quantId).padEnd(20)} ${String(q.open).padStart(4)}  ${String(q.graded).padStart(6)}  ${pct(q.hitRate).padStart(8)}  ${pct(q.graded ? q.lowerBound : null).padStart(11)}  ${pct(q.graded ? q.avgExcess : null).padStart(16)}  ${q.tier}`);
}
console.log(`\nA quant stays Unproven until it has ${MIN_GRADED} graded calls. Calls are graded 63 trading days (~3 months) after they're made.`);
