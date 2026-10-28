// Real-history replay. The market plays real daily closes forward from a start date the
// manager picks. Within each day, prices move from yesterday's real close to today's real
// close along a random path (seeded, so every device sees the same path); the close is exact.
//
// Only the cursor and today's intraday state are saved. The price history itself is loaded
// from state/history/ and attached to the sim without being saved (non-enumerable), so the
// saved fund stays small and nothing beyond the current day is visible to the quants.

import { TICKS_PER_DAY } from './sim.js';

const WARMUP = 260; // trading days of history the quants need before the start date

function rng(state) {
  let t = (state + 0x6D2B79F5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, t];
}
function hash(str) { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

export function earliestStart(hist) { return hist.dates[WARMUP]; }

// hist: { dates, closes: { SYM: [..] } } from joinHistory
export function createReplay(hist, { startDate, seed = 7 }) {
  let cursor = hist.dates.findIndex(d => d >= startDate);
  if (cursor < 0) throw new Error(`No data on or after ${startDate}`);
  cursor = Math.max(cursor, WARMUP);
  const sim = { mode: 'replay', cursor, day: hist.dates[cursor], tick: 0, seed, ended: false, prices: {}, dayOpen: {} };
  attach(sim, hist);
  for (const [s, arr] of Object.entries(hist.closes)) if (arr[cursor - 1] != null) sim.prices[s] = arr[cursor - 1];
  sim.dayOpen = { ...sim.prices };
  return sim;
}

// Rebuilds the unsaved views the rest of the app reads: history (closes up to yesterday,
// per symbol, without gaps) and dates. Call after loading a saved fund and after each day.
export function attach(sim, hist) {
  const history = {};
  for (const [s, arr] of Object.entries(hist.closes)) {
    const h = [];
    for (let i = 0; i < sim.cursor; i++) if (arr[i] != null) h.push(arr[i]);
    if (h.length) history[s] = h;
  }
  Object.defineProperty(sim, 'hist', { value: hist, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(sim, 'history', { value: history, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(sim, 'dates', { value: hist.dates.slice(0, sim.cursor), enumerable: false, configurable: true, writable: true });
  Object.defineProperty(sim, 'paths', { value: {}, enumerable: false, configurable: true, writable: true });
  return sim;
}

// The intraday path for one symbol today: a Brownian bridge from yesterday's close to today's.
function path(sim, sym) {
  const key = `${sym}:${sim.cursor}`;
  if (sim.paths[key]) return sim.paths[key];
  const arr = sim.hist.closes[sym];
  const prev = arr[sim.cursor - 1], close = arr[sim.cursor];
  if (prev == null || close == null) return (sim.paths[key] = null);
  let st = hash(key) ^ sim.seed;
  const T = TICKS_PER_DAY;
  const dayVol = Math.max(0.004, Math.abs(Math.log(close / prev)) * 0.8 + 0.006);
  const w = [0];
  for (let k = 1; k <= T; k++) {
    let u, v;
    [u, st] = rng(st); [v, st] = rng(st);
    const z = Math.sqrt(-2 * Math.log(u || 1e-12)) * Math.cos(2 * Math.PI * v);
    w.push(w[k - 1] + z * dayVol / Math.sqrt(T));
  }
  const lp = Math.log(prev), lc = Math.log(close);
  const out = w.map((x, k) => Math.exp(lp + (lc - lp) * k / T + x - (k / T) * w[T]));
  out[T] = close;
  return (sim.paths[key] = out);
}

export function step(sim) {
  if (sim.ended || sim.tick >= TICKS_PER_DAY) return { closed: false };
  sim.tick++;
  for (const s of Object.keys(sim.hist.closes)) {
    const p = path(sim, s);
    if (p) sim.prices[s] = +p[sim.tick].toPrecision(8);
  }
  return { closed: sim.tick === TICKS_PER_DAY };
}

// After the close: move to the next real trading day, or end when the data runs out.
export function openNextDay(sim) {
  if (sim.cursor + 1 >= sim.hist.dates.length) { sim.ended = true; return; }
  sim.cursor++;
  sim.day = sim.hist.dates[sim.cursor];
  sim.tick = 0;
  attach(sim, sim.hist);
  for (const [s, arr] of Object.entries(sim.hist.closes)) if (arr[sim.cursor - 1] != null) sim.prices[s] = arr[sim.cursor - 1];
  sim.dayOpen = { ...sim.prices };
}

// Closes strictly after `date`, up to the last completed day only (never the future).
export function closesAfter(sim, symbol, date) {
  const arr = sim.hist.closes[symbol] || [];
  const out = [];
  for (let i = 0; i < sim.cursor; i++) if (sim.hist.dates[i] > date && arr[i] != null) out.push(arr[i]);
  return out;
}

// Loads state/history in the browser.
export async function loadHistory(base = '/state/history') {
  const index = await (await fetch(`${base}/index.json`, { cache: 'no-cache' })).json();
  const files = await Promise.all(index.years.map(y => fetch(`${base}/${y}.json`).then(r => { if (!r.ok) throw new Error(`history ${y}: HTTP ${r.status}`); return r.json(); })));
  const { joinHistory } = await import('../src/data/history.js');
  return { index, hist: joinHistory(files) };
}
