// Real-history replay, one trading day at a time. A fund starts at the close of the date the
// manager picks; each step moves to the next real trading day's close. Decisions are made at a
// close, using closes up to that day; approved orders fill at the next close. This is the same
// timing the backtest uses (src/portfolioBacktest.js).
//
// Only the cursor and the current closes are saved. The price history is loaded from
// state/history/ and attached to the sim without being saved (non-enumerable), so the saved fund
// stays small and nothing after the current close is visible to the quants.

const WARMUP = 260; // trading days of history the quants need before the start date

export function earliestStart(hist) { return hist.dates[WARMUP]; }

// hist: { dates, closes, divs?, tr? } from joinHistory
export function createReplay(hist, { startDate }) {
  let cursor = hist.dates.findIndex(d => d >= startDate);
  if (cursor < 0) throw new Error(`No data on or after ${startDate}`);
  cursor = Math.max(cursor, WARMUP);
  const sim = { mode: 'replay', cursor, day: hist.dates[cursor], ended: false, prices: {} };
  attach(sim, hist);
  return sim;
}

// Rebuilds the unsaved views the rest of the app reads. Call after loading a saved fund and
// after each step.
//   prices     closes on the current day (carried from the last close for a symbol with none)
//   history    total-return series up to and including the current day, per symbol, no gaps
//   prevClose  the actual close before the current day, per symbol (for day moves on screen)
//   dates      trading dates up to and including the current day
export function attach(sim, hist) {
  const history = {}, prevClose = {}, prices = {};
  const sig = hist.tr || hist.closes;
  for (const [s, arr] of Object.entries(sig)) {
    const h = [];
    for (let i = 0; i <= sim.cursor; i++) if (arr[i] != null) h.push(arr[i]);
    if (h.length) history[s] = h;
    const raw = hist.closes[s];
    let found = 0;
    for (let i = sim.cursor; i >= 0 && found < 2; i--) {
      if (raw[i] == null) continue;
      if (found === 0) prices[s] = raw[i]; else prevClose[s] = raw[i];
      found++;
    }
  }
  sim.prices = prices;
  Object.defineProperty(sim, 'hist', { value: hist, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(sim, 'history', { value: history, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(sim, 'prevClose', { value: prevClose, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(sim, 'dates', { value: hist.dates.slice(0, sim.cursor + 1), enumerable: false, configurable: true, writable: true });
  return sim;
}

// Moves to the next trading day's close. Returns false (and marks the replay ended) when the
// history has no more days.
export function advance(sim) {
  if (sim.ended) return false;
  if (sim.cursor + 1 >= sim.hist.dates.length) { sim.ended = true; return false; }
  sim.cursor++;
  sim.day = sim.hist.dates[sim.cursor];
  attach(sim, sim.hist);
  return true;
}

// Dividends going ex on the current day, per share: { SYM: amount }. Whoever held the fund at
// the previous close gets paid.
export function dividendsToday(sim) {
  const out = {};
  for (const [s, byIndex] of Object.entries(sim.hist.divs || {})) if (byIndex[sim.cursor]) out[s] = byIndex[sim.cursor];
  return out;
}

// Prices strictly after `date`, up to the current day only (never the future), as total return:
// each is the actual close on `date` grown by the fund's return since, dividends included.
// Used to grade calls.
export function closesAfter(sim, symbol, date) {
  const tr = (sim.hist.tr || sim.hist.closes)[symbol] || [];
  const raw = sim.hist.closes[symbol] || [];
  let base = null;
  for (let i = 0; i <= sim.cursor && sim.hist.dates[i] <= date; i++) if (tr[i] != null) base = i;
  const out = [];
  for (let i = 0; i <= sim.cursor; i++) {
    if (sim.hist.dates[i] <= date || tr[i] == null) continue;
    out.push(base == null ? raw[i] : raw[base] * tr[i] / tr[base]);
  }
  return out;
}

// Loads state/history in the browser.
export async function loadHistory(base = '/state/history') {
  const res = await fetch(`${base}/index.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`price history index: HTTP ${res.status}`);
  const index = await res.json();
  const files = await Promise.all(index.years.map(y => fetch(`${base}/${y}.json`).then(r => { if (!r.ok) throw new Error(`price history ${y}: HTTP ${r.status}`); return r.json(); })));
  const { joinHistory } = await import('../src/data/history.js');
  return { index, hist: joinHistory(files) };
}
