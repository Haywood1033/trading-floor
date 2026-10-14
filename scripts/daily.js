// Daily run (GitHub Actions, after the US close). No broker and no keys: prices come from
// Yahoo, and the account is a simulated paper account kept in state/account.json.
// Runs every quant, records and grades calls in state/signals.json, writes state/feed.json.
// Never places orders anywhere.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchDaily } from '../src/data/yahoo.js';
import { createTracker } from '../src/tracking/tracker.js';
import { fileSignalStore } from '../src/node/fileStores.js';
import { runDesk, symbolsNeeded } from '../src/engine.js';

const ACCOUNT = 'state/account.json';
let account;
try { account = JSON.parse(readFileSync(ACCOUNT, 'utf8')); }
catch { account = { cash: 100000, positions: {}, note: 'Simulated paper account. Edit positions to mirror real holdings.' }; }

const history = {}, missing = [];
for (const s of symbolsNeeded({ positions: account.positions })) {
  try { history[s] = await fetchDaily(s, { range: '2y' }); } catch (e) { missing.push(`${s}: ${e.message}`); }
}
const prices = Object.fromEntries(Object.entries(history).map(([s, rows]) => [s, rows.map(r => r.c)]));

// Mark positions to the latest close; yesterday's close sets the daily loss baseline.
const positions = {};
let prevEquity = account.cash;
for (const [s, p] of Object.entries(account.positions)) {
  const rows = history[s];
  const price = rows ? rows[rows.length - 1].c : p.price;
  const prev = rows && rows.length > 1 ? rows[rows.length - 2].c : price;
  positions[s] = { ...p, price };
  prevEquity += p.qty * prev;
}
const snapshot = { cash: account.cash, positions, startOfDayEquity: prevEquity, dayTradesUsed: 0 };

const tracker = createTracker(fileSignalStore('state/signals.json'));
const feed = await runDesk({
  snapshot, prices, tracker,
  closesAfter: async (sym, date) => (history[sym] || await fetchDaily(sym, { range: '2y' })).filter(r => r.date > date).map(r => r.c),
  source: 'Simulated paper account, Yahoo daily prices'
});
feed.missingPrices = missing;

mkdirSync('state', { recursive: true });
writeFileSync(ACCOUNT, JSON.stringify({ ...account, positions: Object.fromEntries(Object.entries(positions).map(([s, p]) => [s, { ...p }])) }, null, 2));
writeFileSync('state/feed.json', JSON.stringify(feed, null, 2));

const usd = v => '$' + Math.round(v).toLocaleString('en-US');
console.log(`${feed.source}: equity ${usd(feed.account.equity)}, cash ${usd(feed.account.cash)}, ${Object.keys(positions).length} positions`);
for (const p of feed.proposals) {
  const status = p.risk.approved ? 'passes risk' + (p.resizedFrom ? ` (resized from ${p.resizedFrom})` : '') : 'BLOCKED: ' + p.risk.checks.filter(c => !c.ok).map(c => c.message).join(', ');
  console.log(`${p.quantId}  ${p.side.toUpperCase()} ${p.qty} ${p.symbol} @ ~$${p.price.toFixed(2)}  [${status}]${p.newCall ? '' : ' (already tracking)'}`);
  console.log(`     ${p.thesis}`);
}
for (const q of feed.scoreboard) console.log(`${q.name}: ${q.open} open, ${q.graded} graded, tier ${q.tier}`);
if (missing.length) console.log(`Missing prices:\n  ${missing.join('\n  ')}`);
