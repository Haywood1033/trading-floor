// Fetches daily closes and dividends from Yahoo (no account or key) for the ETF universe and
// BTC/ETH, and writes state/history/. Runs on GitHub Actions.
//
// Past years are frozen: a stored format-2 year file older than last year is never rewritten,
// so a fund replaying old dates always sees the same prices. Differences between the stored
// and freshly fetched values for those years are reported, not applied.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchDaily } from '../src/data/yahoo.js';
import { buildHistory, FORMAT } from '../src/data/history.js';
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
    const divs = rows.filter(r => r.div > 0).length;
    console.log(`${s.padEnd(4)} ${rows[0].date} -> ${rows.at(-1).date} (${rows.length} days, ${divs} dividends)`);
  } catch (e) { missing.push(`${s}: ${e.message}`); }
}
if (!series.SPY) { console.error('SPY missing; aborting.', missing); process.exit(1); }
if (missing.length) { console.error('Missing symbols:\n  ' + missing.join('\n  ')); process.exit(1); }

const { index, files } = buildHistory(series, metaFor);
mkdirSync('state/history', { recursive: true });
const thisYear = new Date().getUTCFullYear();
let written = 0, frozen = 0;
for (const f of files) {
  const path = `state/history/${f.year}.json`;
  const old = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  if (old?.format === FORMAT && f.year < thisYear - 1) {
    frozen++;
    let diffs = 0;
    for (const [s, arr] of Object.entries(f.closes)) arr.forEach((v, i) => { const o = old.closes[s]?.[i]; if (v != null && o != null && Math.abs(v / o - 1) > 1e-6) diffs++; });
    if (diffs) console.log(`${f.year}: frozen; Yahoo now differs on ${diffs} stored closes (kept the stored values)`);
    continue;
  }
  writeFileSync(path, JSON.stringify(f));
  written++;
}
writeFileSync('state/history/index.json', JSON.stringify(index, null, 2));
console.log(`Wrote ${written} year files, kept ${frozen} frozen, ${index.first} to ${index.last}.`);
