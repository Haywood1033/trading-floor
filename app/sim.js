// Simulated market for Phase 1. Pure and deterministic (seeded), so it can be persisted in
// the browser and tested in Node.
//
// A trading day is TICKS_PER_DAY five-minute steps from 9:30 to 16:00. Each symbol moves with
// a shared market factor plus its own drift and noise, calibrated from its sample history.

export const TICKS_PER_DAY = 78;
const MARKET = { mu: 0.0003, sigma: 0.009 };

function rng(state) {
  // mulberry32; returns [value in [0,1), next state]
  let t = (state + 0x6D2B79F5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, t];
}
function gauss(sim) {
  let u, v;
  [u, sim.seed] = rng(sim.seed);
  [v, sim.seed] = rng(sim.seed);
  return Math.sqrt(-2 * Math.log(u || 1e-12)) * Math.cos(2 * Math.PI * v);
}

export function nextBusinessDay(date) {
  const d = new Date(date + 'T12:00:00Z');
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
function prevBusinessDay(date) {
  const d = new Date(date + 'T12:00:00Z');
  do d.setUTCDate(d.getUTCDate() - 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

// Daily drift and idiosyncratic volatility from the last ~6 months of a series.
function calibrate(closes, crypto) {
  const r = [];
  for (let i = Math.max(1, closes.length - 126); i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length);
  const beta = crypto ? 0.4 : 1;
  return { beta, mu: Math.max(-0.002, Math.min(0.002, mean - beta * MARKET.mu)), sigma: Math.max(0.004, Math.min(0.05, sd)) };
}

// bars: { [symbol]: closes[] } ending at the previous close. startDate: first simulated day.
export function createSim({ bars, startDate, seed = 20261014, crypto = ['BTC', 'ETH', 'SOL'] }) {
  const n = bars.SPY.length;
  const dates = [];
  let d = startDate;
  for (let i = 0; i < n; i++) { d = prevBusinessDay(d); dates.unshift(d); }
  const params = {};
  const prices = {};
  for (const [s, closes] of Object.entries(bars)) {
    params[s] = calibrate(closes, crypto.includes(s));
    prices[s] = closes[closes.length - 1];
  }
  return {
    day: startDate, tick: 0, seed: seed >>> 0,
    dates, history: structuredClone(bars), prices, params,
    dayOpen: { ...prices }
  };
}

export function clockLabel(sim) {
  const mins = 9 * 60 + 30 + sim.tick * 5;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Advances one five-minute step. Returns { closed } when that step ended the session; the
// caller then handles end-of-day work and calls openNextDay().
export function step(sim) {
  if (sim.tick >= TICKS_PER_DAY) return { closed: false };
  const dt = 1 / TICKS_PER_DAY;
  const m = MARKET.mu * dt + MARKET.sigma * Math.sqrt(dt) * gauss(sim);
  for (const s of Object.keys(sim.prices)) {
    const p = sim.params[s];
    const r = p.beta * m + p.mu * dt + p.sigma * Math.sqrt(dt) * gauss(sim);
    sim.prices[s] = +(sim.prices[s] * Math.exp(r)).toFixed(4);
  }
  sim.tick++;
  return { closed: sim.tick === TICKS_PER_DAY };
}

// Records today's closes into history and moves to the next trading day's open.
export function openNextDay(sim, maxHistory = 400) {
  for (const s of Object.keys(sim.prices)) {
    sim.history[s].push(sim.prices[s]);
    if (sim.history[s].length > maxHistory) sim.history[s].shift();
  }
  sim.dates.push(sim.day);
  if (sim.dates.length > maxHistory) sim.dates.shift();
  sim.day = nextBusinessDay(sim.day);
  sim.tick = 0;
  sim.dayOpen = { ...sim.prices };
}

// Closes strictly after `date`, for grading calls.
export function closesAfter(sim, symbol, date) {
  const out = [];
  for (let i = 0; i < sim.dates.length; i++) if (sim.dates[i] > date) out.push(sim.history[symbol][i]);
  return out;
}
