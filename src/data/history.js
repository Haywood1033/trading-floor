// Price history files in state/history/: one file per year plus an index, aligned to US
// trading days (SPY's dates).
//
// index.json: { updated, format, first, last, years: [..], symbols: { SYM: { first, name, sector, group } } }
// YYYY.json (format 2):
//   { year, format: 2, dates: [..], closes: { SYM: [actual close|null, ..] },
//     dividends: { SYM: { 'YYYY-MM-DD': cash per share } } }
//
// Actual closes and dividends don't change once a day has passed, so past years are frozen
// (scripts/fetch-history.js only rewrites recent years). Format 1 files held Yahoo's
// dividend-adjusted closes, which Yahoo rewrites after every dividend; they are still read.

export const FORMAT = 2;

export function buildHistory(series, meta) {
  const spy = series.SPY;
  if (!spy?.length) throw new Error('SPY history is required to define trading days');
  const dates = spy.map(r => r.date);
  const dateSet = new Set(dates);
  const byYear = {};
  const lookup = Object.fromEntries(Object.entries(series).map(([s, rows]) => [s, new Map(rows.map(r => [r.date, r]))]));
  dates.forEach(d => {
    const y = d.slice(0, 4);
    const f = (byYear[y] ||= { year: +y, format: FORMAT, dates: [], closes: Object.fromEntries(Object.keys(series).map(s => [s, []])), dividends: {} });
    f.dates.push(d);
    for (const s of Object.keys(series)) {
      const r = lookup[s].get(d);
      f.closes[s].push(r == null ? null : +r.close.toPrecision(7));
    }
  });
  // A dividend whose ex-date isn't a US trading day (rare) is credited on the next one.
  for (const [s, rows] of Object.entries(series)) {
    for (const r of rows) {
      if (!(r.div > 0)) continue;
      const d = dateSet.has(r.date) ? r.date : dates.find(x => x > r.date);
      if (!d) continue;
      const f = byYear[d.slice(0, 4)];
      (f.dividends[s] ||= {})[d] = +((f.dividends[s][d] || 0) + r.div).toPrecision(7);
    }
  }
  const symbols = {};
  for (const [s, rows] of Object.entries(series)) symbols[s] = { first: rows.find(r => dateSet.has(r.date))?.date || null, ...(meta(s) || {}) };
  const index = { updated: new Date().toISOString(), format: FORMAT, first: dates[0], last: dates.at(-1), years: Object.keys(byYear).map(Number), symbols };
  return { index, files: Object.values(byYear) };
}

// Joins year files into one aligned series:
//   { dates, closes: { SYM: [actual close] }, divs: { SYM: { index: cash per share } },
//     tr: { SYM: [total-return index] } }
// `tr` reinvests dividends (it starts at the first close and grows by (close + div) / prev close).
// Signals use `tr`; valuation uses `closes` with dividends paid as cash.
export function joinHistory(files) {
  const sorted = [...files].sort((a, b) => a.year - b.year);
  const out = { dates: [], closes: {}, divs: {} };
  for (const f of sorted) {
    const n0 = out.dates.length;
    out.dates.push(...f.dates);
    for (const [s, arr] of Object.entries(f.closes)) {
      out.closes[s] ||= Array(n0).fill(null);
      out.closes[s].push(...arr);
    }
    for (const s of Object.keys(out.closes)) if (out.closes[s].length < out.dates.length) out.closes[s].push(...Array(out.dates.length - out.closes[s].length).fill(null));
    for (const [s, byDate] of Object.entries(f.dividends || {})) {
      for (const [d, amt] of Object.entries(byDate)) {
        const i = f.dates.indexOf(d);
        if (i >= 0) (out.divs[s] ||= {})[n0 + i] = amt;
      }
    }
  }
  out.tr = {};
  for (const [s, c] of Object.entries(out.closes)) {
    const tr = Array(c.length).fill(null);
    let prev = null, level = null;
    for (let i = 0; i < c.length; i++) {
      if (c[i] == null) continue;
      level = level == null ? c[i] : level * (c[i] + (out.divs[s]?.[i] || 0)) / prev;
      tr[i] = level;
      prev = c[i];
    }
    out.tr[s] = tr;
  }
  return out;
}
