// Fetches daily adjusted closes from Yahoo (no account or key) for the ETF universe and
// BTC/ETH, and writes state/history/. Runs on GitHub Actions.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchDaily } from '../src/data/yahoo.js';
import { buildHistory } from '../src/data/history.js';
import { ETF_SYMBOLS, CRYPTO_REPLAY, metaFor } from '../src/data/universe.js';

const FROM = '2004-01-01';
const series = {}, missing = [];
for (const s of [...ETF_SYMBOLS, ...CRYPTO_REPLAY.map(c => c.symbol)]) {
  try {
    const rows = (await fetchDaily(s, { from: FROM })).filter(r => r.date >= FROM);
    if (!rows.length) throw new Error('no rows');
    // Guard against non-daily data: a year of trading has ~252 rows (crypto ~365).
    const years = (Date.parse(rows.at(-1).date) - Date.parse(rows[0].date)) / (365.25 * 864e5);
    if (years > 0.5 && rows.length / years < 200) throw new Error(`only ${Math.round(rows.length / years)} rows a year; not daily data`);
    series[s] = rows;
    console.log(`${s.padEnd(4)} ${rows[0].date} -> ${rows.at(-1).date} (${rows.length} days)`);
  } catch (e) { missing.push(`${s}: ${e.message}`); }
}
if (!series.SPY) { console.error('SPY missing; aborting.', missing); process.exit(1); }
if (missing.length) { console.error('Missing symbols:\n  ' + missing.join('\n  ')); process.exit(1); }

const { index, files } = buildHistory(series, metaFor);
mkdirSync('state/history', { recursive: true });
for (const f of files) writeFileSync(`state/history/${f.year}.json`, JSON.stringify(f));
writeFileSync('state/history/index.json', JSON.stringify(index, null, 2));
console.log(`Wrote ${files.length} year files, ${index.first} to ${index.last}.`);
