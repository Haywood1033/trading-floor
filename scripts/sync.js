// Read-only sync: prints the Alpaca account as the trading floor sees it, plus risk exposure.
//   ALPACA_KEY_ID=... ALPACA_SECRET_KEY=... node scripts/sync.js
// Never places orders.

import { createAlpacaBroker, snapshotFrom } from '../src/brokers/alpaca.js';
import { summarize } from '../src/core/portfolio.js';
import { DEFAULT_LIMITS } from '../src/risk/limits.js';

const usd = v => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = v => (v * 100).toFixed(1) + '%';

const broker = createAlpacaBroker({ readOnly: true });
const [clock, snap] = await Promise.all([broker.getClock(), snapshotFrom(broker)]);
const s = summarize(snap);
const day = s.equity / snap.startOfDayEquity - 1;

console.log(`${broker.name}  market ${clock.isOpen ? 'OPEN' : 'closed'}`);
console.log(`Equity ${usd(s.equity)}  day ${pct(day)}  cash ${usd(s.cash)} (${pct(s.cash / s.equity)})`);
console.log(`Stocks ${usd(s.stocks)}  crypto ${usd(s.crypto)} (${pct(s.crypto / s.equity)} / ${pct(DEFAULT_LIMITS.maxCryptoPct)})`);
console.log(`Day trades used (5-day): ${snap.dayTradesUsed}`);
console.log('');
const rows = Object.entries(snap.positions).sort((a, b) => b[1].qty * b[1].price - a[1].qty * a[1].price);
if (!rows.length) console.log('No positions yet.');
for (const [sym, p] of rows) {
  const v = p.qty * p.price, w = v / s.equity;
  const flag = p.assetClass === 'stock' && w > DEFAULT_LIMITS.maxPositionPct ? '  OVER 10%' : '';
  console.log(`${sym.padEnd(6)} ${String(p.qty).padStart(10)}  ${usd(v).padStart(12)}  ${pct(w).padStart(6)}  ${p.sector}${flag}`);
}
for (const [sector, cap] of Object.entries(DEFAULT_LIMITS.sectorLimits)) {
  const w = (s.bySector[sector] || 0) / s.equity;
  console.log(`\n${sector} exposure ${pct(w)} / ${pct(cap)}`);
}
