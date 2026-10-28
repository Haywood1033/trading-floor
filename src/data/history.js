// Price history files in state/history/: one file per year plus an index, aligned to US
// trading days (SPY's dates). Only the current year's file changes day to day.
//
// index.json: { updated, first, last, years: [..], symbols: { SYM: { first, name, sector, group } } }
// YYYY.json:  { year, dates: [..], closes: { SYM: [number|null, ..] } }

export function buildHistory(series, meta) {
  const spy = series.SPY;
  if (!spy?.length) throw new Error('SPY history is required to define trading days');
  const dates = spy.map(r => r.date);
  const byYear = {};
  const lookup = Object.fromEntries(Object.entries(series).map(([s, rows]) => [s, new Map(rows.map(r => [r.date, r.c]))]));
  dates.forEach((d, i) => {
    const y = d.slice(0, 4);
    const f = (byYear[y] ||= { year: +y, dates: [], closes: Object.fromEntries(Object.keys(series).map(s => [s, []])) });
    f.dates.push(d);
    for (const s of Object.keys(series)) {
      const v = lookup[s].get(d);
      f.closes[s].push(v == null ? null : +v.toPrecision(7));
    }
  });
  const symbols = {};
  for (const [s, rows] of Object.entries(series)) symbols[s] = { first: rows.find(r => dates.includes(r.date))?.date || null, ...(meta(s) || {}) };
  const index = { updated: new Date().toISOString(), first: dates[0], last: dates.at(-1), years: Object.keys(byYear).map(Number), symbols };
  return { index, files: Object.values(byYear) };
}

// Joins year files back into one aligned series: { dates, closes: { SYM: [...] } }
export function joinHistory(files) {
  const sorted = [...files].sort((a, b) => a.year - b.year);
  const out = { dates: [], closes: {} };
  for (const f of sorted) {
    const n0 = out.dates.length;
    out.dates.push(...f.dates);
    for (const [s, arr] of Object.entries(f.closes)) {
      out.closes[s] ||= Array(n0).fill(null);
      out.closes[s].push(...arr);
    }
    for (const s of Object.keys(out.closes)) if (out.closes[s].length < out.dates.length) out.closes[s].push(...Array(out.dates.length - out.closes[s].length).fill(null));
  }
  return out;
}
