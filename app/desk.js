// The fund: state plus every action the manager or the desk can take. No DOM here, so it is
// tested in Node and shared by every screen.
//
// Every fill goes through fill(), which always runs the risk manager first (kill switch
// included). There is no other path that changes positions or cash.

import { createSim, step, openNextDay, closesAfter, TICKS_PER_DAY } from './sim.js';
import { sampleBars } from '../src/data/sample.js';
import { reviewPortfolio } from '../src/quants/portfolioReviewer.js';
import { runMomentum, DEFAULT_UNIVERSE } from '../src/quants/momentum.js';
import { evaluateOrder, canAutoExecute, maxQtyWithinLimits } from '../src/risk/riskManager.js';
import { createTracker, gradeSignal } from '../src/tracking/tracker.js';
import { summarize } from '../src/core/portfolio.js';
import { DEFAULT_LIMITS } from '../src/risk/limits.js';
import { sectorOf } from '../src/core/sectors.js';

export const STATE_VERSION = 1;
export const CRYPTO = ['BTC', 'ETH', 'SOL'];
export const QUANTS = [
  { id: 'rev', name: 'Portfolio reviewer', desc: 'Flags stale holdings and oversized positions; proposes sells and trims.' },
  { id: 'mom', name: 'Momentum', desc: 'Buys 12-1 month return leaders above their 200-day average, ~5% each.' }
];
export const quantName = id => (id === 'manager' ? 'Manager' : QUANTS.find(q => q.id === id)?.name || id);
// Most of the fund each quant's positions may hold (buys beyond it are blocked). null = no cap.
export const DEFAULT_ALLOC = { rev: null, mom: 0.6 };

// Fills in fields added after a fund was first saved, so older saved funds keep working.
export function migrate(state) {
  state.peakEquity ??= Math.max(state.fund.capital, ...state.curve.daily.map(d => d.equity));
  state.fund.spyStart ??= state.sim.prices.SPY;
  state.settings.quantAlloc ??= { ...DEFAULT_ALLOC };
  state.settings.limits = { ...DEFAULT_LIMITS, ...state.settings.limits };
  return state;
}

export function freshState({ startDate = '2026-10-14', capital = 100000, seed = 20261014 } = {}) {
  const sim = createSim({ bars: sampleBars(), startDate, seed, crypto: CRYPTO });
  return {
    version: STATE_VERSION,
    fund: { name: 'Trading Floor', capital, inception: startDate, spyStart: sim.prices.SPY },
    sim,
    account: { cash: capital, positions: {}, realized: 0 },
    startOfDayEquity: capital,
    peakEquity: capital,
    openedDay: null,
    orders: [],
    signals: [],
    log: [],
    kill: { halted: false },
    settings: { mode: 'approval', speed: 1, limits: structuredClone(DEFAULT_LIMITS), quantModes: { rev: 'live', mom: 'live' }, quantAlloc: { ...DEFAULT_ALLOC } },
    curve: { intraday: [capital], daily: [] },
    seq: 1
  };
}

// ---------- reads

export function snapshot(state) {
  const positions = {};
  for (const [s, p] of Object.entries(state.account.positions)) positions[s] = { ...p, price: state.sim.prices[s] };
  return { cash: state.account.cash, positions, startOfDayEquity: state.startOfDayEquity };
}
export const totals = state => summarize(snapshot(state));
export const marketOpen = state => state.sim.tick < TICKS_PER_DAY;
export const pending = state => state.orders.filter(o => o.status === 'pending');
const ctx = (state, order) => ({
  limits: state.settings.limits, halted: state.kill.halted, peakEquity: state.peakEquity,
  dayTradesUsed: dayTradesUsed(state), opensDayTrade: order ? opensDayTrade(state, order) : false
});

// ---------- compliance helpers (day trades, wash sales)

const fillsOn = (state, day) => state.orders.filter(o => o.status === 'filled' && o.filledAt?.startsWith(day));
// A day trade: buying and selling the same symbol on the same day.
export function opensDayTrade(state, order) {
  const today = fillsOn(state, state.sim.day).filter(o => o.symbol === order.symbol);
  return today.some(o => o.side !== order.side);
}
export function dayTradeLog(state) {
  const days = [...state.sim.dates.slice(-4), state.sim.day];
  const out = [];
  for (const day of days) {
    const bySym = {};
    for (const o of fillsOn(state, day)) (bySym[o.symbol] ||= new Set()).add(o.side);
    for (const [symbol, sides] of Object.entries(bySym)) if (sides.size === 2) out.push({ day, symbol });
  }
  return out;
}
export const dayTradesUsed = state => dayTradeLog(state).length;
const dayNum = d => Date.parse(d + 'T12:00:00Z') / 864e5;
// Stock sales at a loss in the last 30 days, and whether the same stock was bought within 30 days of the sale.
export function washSaleWatch(state) {
  const today = dayNum(state.sim.day);
  const fills = state.orders.filter(o => o.status === 'filled');
  return fills.filter(o => o.side === 'sell' && o.realized < 0 && o.assetClass !== 'crypto' && today - dayNum(o.filledAt.slice(0, 10)) <= 30)
    .map(o => {
      const t = dayNum(o.filledAt.slice(0, 10));
      const rebuy = fills.find(b => b.side === 'buy' && b.symbol === o.symbol && b.id !== o.id && Math.abs(dayNum(b.filledAt.slice(0, 10)) - t) <= 30);
      return { symbol: o.symbol, date: o.filledAt.slice(0, 10), loss: o.realized, rebought: rebuy ? rebuy.filledAt.slice(0, 10) : null, clearOn: new Date((t + 31) * 864e5).toISOString().slice(0, 10) };
    });
}

// ---------- quant capital allocation

export function quantExposure(state, quantId) {
  let v = 0;
  for (const [sym, p] of Object.entries(state.account.positions)) if (p.openedBy === quantId) v += p.qty * state.sim.prices[sym];
  return v;
}
function allocationCheck(state, order) {
  const cap = state.settings.quantAlloc?.[order.quantId];
  if (order.side !== 'buy' || cap == null) return null;
  const eq = totals(state).equity;
  const after = quantExposure(state, order.quantId) + order.qty * order.price;
  return { id: 'quantAllocation', ok: after <= cap * eq + 1e-6, message: `${quantName(order.quantId)} capital ${(after / eq * 100).toFixed(1)}% / ${(cap * 100).toFixed(0)}%` };
}

// Risk manager plus desk-level checks (quant capital). Used by every path that fills.
export function evaluate(state, order) {
  const r = evaluateOrder(order, snapshot(state), ctx(state, order));
  const a = allocationCheck(state, order);
  if (a) r.checks.push(a);
  return { approved: r.checks.every(c => c.ok), checks: r.checks };
}

export function tracker(state) {
  return createTracker({ load: () => state.signals, save: rows => { state.signals = rows; } });
}
export function scoreboard(state) {
  const board = Object.fromEntries(tracker(state).scoreboard().map(q => [q.quantId, q]));
  return QUANTS.map(q => ({ ...q, mode: state.settings.quantModes[q.id], ...(board[q.id] || { open: 0, graded: 0, hits: 0, hitRate: null, avgExcess: 0, tier: 'unproven' }) }));
}
export const tierOf = (state, quantId) => scoreboard(state).find(q => q.id === quantId)?.tier || 'unproven';

// Live risk view of a pending order at the current price.
export function riskFor(state, order) {
  const o = { ...order, price: state.sim.prices[order.symbol] };
  const risk = evaluate(state, o);
  let fit = !risk.approved && o.side === 'buy' && !state.kill.halted ? maxQtyWithinLimits(o, snapshot(state), ctx(state, o), stepFor(o.symbol)) : 0;
  const cap = state.settings.quantAlloc?.[o.quantId];
  if (fit && cap != null) {
    const room = cap * totals(state).equity - quantExposure(state, o.quantId);
    const st = stepFor(o.symbol);
    fit = Math.min(fit, Math.max(0, Math.floor(room / o.price / st) * st));
    fit = +fit.toFixed(6);
  }
  const autoBase = canAutoExecute(o, snapshot(state), { ...ctx(state, o), mode: state.settings.mode, quantTier: tierOf(state, o.quantId) });
  const allocFail = risk.checks.find(c => c.id === 'quantAllocation' && !c.ok);
  const auto = allocFail ? { auto: false, reasons: [...autoBase.reasons, allocFail.message] } : autoBase;
  return { ...risk, fit, auto, price: o.price, value: o.qty * o.price };
}
export const stepFor = symbol => (CRYPTO.includes(symbol) ? (symbol === 'BTC' ? 0.001 : symbol === 'ETH' ? 0.01 : 0.1) : 1);

// ---------- writes

export function log(state, kind, text, extra = {}) {
  state.log.unshift({ at: `${state.sim.day} ${clock(state)}`, kind, text, ...extra });
  if (state.log.length > 500) state.log.length = 500;
}
function clock(state) {
  const mins = 9 * 60 + 30 + state.sim.tick * 5;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// Market open: price the book, run every live/paper quant, queue live proposals, record calls.
export function openDay(state) {
  if (state.openedDay === state.sim.day) return;
  state.openedDay = state.sim.day;
  state.startOfDayEquity = totals(state).equity;
  state.curve.intraday = [state.startOfDayEquity];
  log(state, 'system', `Market open ${state.sim.day}. NAV ${usd(state.startOfDayEquity)}.`);
  if (state.kill.halted) { log(state, 'halt', 'Trading halted: quants not run.'); return; }

  const bars = state.sim.history;
  const snap = snapshot(state);
  const runs = {
    rev: () => reviewPortfolio(snap, bars).proposals,
    mom: () => runMomentum(snap, bars, { universe: DEFAULT_UNIVERSE }).proposals
  };
  const t = tracker(state);
  for (const q of QUANTS) {
    const mode = state.settings.quantModes[q.id];
    if (mode === 'off') continue;
    const proposals = runs[q.id]();
    if (!proposals.length) { log(state, 'signal', `${q.name}: nothing to propose.`); continue; }
    let queued = 0;
    for (const p of proposals) {
      p.price = state.sim.prices[p.symbol];
      const benchmark = p.assetClass === 'crypto' && p.symbol !== 'BTC' ? 'BTC' : 'SPY';
      t.record(p, { benchmark, benchEntry: state.sim.prices[benchmark], issuedOn: state.sim.day });
      if (mode === 'paper') continue;
      if (pending(state).some(o => o.symbol === p.symbol && o.side === p.side)) continue;
      state.orders.unshift({
        id: state.seq++, status: 'pending', created: state.sim.day, quantId: q.id,
        symbol: p.symbol, side: p.side, qty: p.qty, proposedQty: p.qty, sector: p.sector || sectorOf(p.symbol, p.assetClass),
        assetClass: p.assetClass, confidence: p.confidence, thesis: p.thesis
      });
      queued++;
    }
    log(state, mode === 'paper' ? 'paper' : 'signal',
      mode === 'paper' ? `${q.name}: ${proposals.length} call${proposals.length > 1 ? 's' : ''} recorded on paper, not queued.`
                       : `${q.name}: ${queued} proposal${queued === 1 ? '' : 's'} queued.`);
  }
  autoRun(state);
}

// The only way positions and cash change.
export function fill(state, id, approvedBy) {
  const o = state.orders.find(x => x.id === id && x.status === 'pending');
  if (!o) return { ok: false, reason: 'Order is no longer pending' };
  if (!marketOpen(state)) return { ok: false, reason: 'Market is closed' };
  const price = state.sim.prices[o.symbol];
  const order = { ...o, price };
  const risk = evaluate(state, order);
  if (!risk.approved) {
    const failed = risk.checks.filter(c => !c.ok).map(c => c.message);
    log(state, 'veto', `${o.side.toUpperCase()} ${fmtQty(o)} ${o.symbol} blocked: ${failed.join(', ')}`);
    return { ok: false, reason: failed.join(', ') };
  }
  const a = state.account;
  const value = o.qty * price;
  const pos = a.positions[o.symbol];
  let realized = null;
  if (o.side === 'buy') {
    a.cash -= value;
    a.positions[o.symbol] = pos
      ? { ...pos, qty: +(pos.qty + o.qty).toFixed(6), costBasis: pos.costBasis + value }
      : { qty: o.qty, costBasis: value, sector: o.sector, assetClass: o.assetClass, opened: state.sim.day, openedBy: o.quantId };
  } else {
    const basisOut = pos.costBasis * (o.qty / pos.qty);
    realized = value - basisOut;
    o.realized = realized;
    o.attribution = pos.openedBy || 'manager';
    a.realized += realized;
    a.cash += value;
    const left = +(pos.qty - o.qty).toFixed(6);
    if (left <= 1e-9) delete a.positions[o.symbol];
    else a.positions[o.symbol] = { ...pos, qty: left, costBasis: pos.costBasis - basisOut };
  }
  Object.assign(o, { status: 'filled', filledAt: `${state.sim.day} ${clock(state)}`, fillPrice: price, approvedBy });
  log(state, 'fill', `${o.side.toUpperCase()} ${fmtQty(o)} ${o.symbol} @ ${usd(price, 2)} (${usd(value)})` +
    (realized != null ? `, realized ${realized >= 0 ? '+' : ''}${usd(realized)}` : '') + (approvedBy === 'auto' ? ', auto' : ', approved by you'));
  return { ok: true };
}

export const approve = (state, id) => fill(state, id, 'manager');

export function reject(state, id) {
  const o = state.orders.find(x => x.id === id && x.status === 'pending');
  if (!o) return;
  o.status = 'rejected';
  log(state, 'reject', `${o.side.toUpperCase()} ${fmtQty(o)} ${o.symbol} rejected by you.`);
}

export function setQty(state, id, qty) {
  const o = state.orders.find(x => x.id === id && x.status === 'pending');
  if (!o || !(qty > 0)) return;
  if (o.side === 'sell') qty = Math.min(qty, state.account.positions[o.symbol]?.qty ?? qty);
  o.qty = +qty.toFixed(6);
}

export function resizeToFit(state, id) {
  const o = state.orders.find(x => x.id === id && x.status === 'pending');
  if (!o) return;
  const fit = riskFor(state, o).fit;
  if (fit > 0) { log(state, 'system', `${o.symbol} resized from ${fmtQty(o)} to ${fit} to fit limits.`); o.qty = fit; }
}

// Manager's own trade from the ticket: same risk checks, fills immediately if they pass.
export function placeManual(state, { symbol, side, qty }) {
  qty = +qty;
  if (!state.sim.prices[symbol]) return { ok: false, reason: `Unknown symbol ${symbol}` };
  if (!(qty > 0)) return { ok: false, reason: 'Enter a quantity above zero' };
  const assetClass = CRYPTO.includes(symbol) ? 'crypto' : 'stock';
  const o = {
    id: state.seq++, status: 'pending', created: state.sim.day, quantId: 'manager', symbol, side, qty: +qty.toFixed(6), proposedQty: qty,
    sector: state.account.positions[symbol]?.sector || sectorOf(symbol, assetClass), assetClass, confidence: null, thesis: 'Manager ticket.'
  };
  const pre = evaluate(state, { ...o, price: state.sim.prices[symbol] });
  if (!pre.approved || !marketOpen(state)) {
    const reason = !marketOpen(state) ? 'Market is closed' : pre.checks.filter(c => !c.ok).map(c => c.message).join(', ');
    state.seq--;
    log(state, 'veto', `Manager ${side.toUpperCase()} ${fmtQty(o)} ${symbol} blocked: ${reason}`);
    return { ok: false, reason };
  }
  state.orders.unshift(o);
  return fill(state, o.id, 'manager');
}
export function previewManual(state, { symbol, side, qty }) {
  if (!state.sim.prices[symbol] || !(+qty > 0)) return null;
  const assetClass = CRYPTO.includes(symbol) ? 'crypto' : 'stock';
  const o = { quantId: 'manager', symbol, side, qty: +qty, price: state.sim.prices[symbol], sector: state.account.positions[symbol]?.sector || sectorOf(symbol, assetClass), assetClass };
  return { ...evaluate(state, o), price: o.price, value: o.qty * o.price };
}
export const closePosition = (state, symbol) => placeManual(state, { symbol, side: 'sell', qty: state.account.positions[symbol]?.qty });

// Manager changes limits. Logs each change with old and new values.
export function updateLimits(state, changes) {
  const L = state.settings.limits;
  const notes = [];
  for (const [k, v] of Object.entries(changes)) {
    const old = JSON.stringify(L[k]);
    if (old === JSON.stringify(v)) continue;
    L[k] = v;
    notes.push(`${k} ${old} → ${JSON.stringify(v)}`);
  }
  if (notes.length) { log(state, 'system', `Risk limits changed: ${notes.join('; ')}.`); autoRun(state); }
  return notes.length;
}
export function resetLimits(state) {
  state.settings.limits = structuredClone(DEFAULT_LIMITS);
  log(state, 'system', 'Risk limits reset to defaults.');
}
export function setQuantAlloc(state, id, value) {
  const old = state.settings.quantAlloc[id];
  if (old === value) return;
  state.settings.quantAlloc[id] = value;
  log(state, 'system', `${quantName(id)} capital cap ${old == null ? 'none' : (old * 100).toFixed(0) + '%'} → ${value == null ? 'none' : (value * 100).toFixed(0) + '%'}.`);
}

export function autoRun(state) {
  if (state.settings.mode !== 'auto' || state.kill.halted || !marketOpen(state)) return;
  for (const o of pending(state)) if (riskFor(state, o).auto.auto) fill(state, o.id, 'auto');
}

export function setMode(state, mode) {
  if (state.settings.mode === mode) return;
  state.settings.mode = mode;
  log(state, 'system', mode === 'auto' ? 'Switched to auto within limits.' : 'Switched to approve each trade.');
  autoRun(state);
}

export function setQuantMode(state, id, mode) {
  if (state.settings.quantModes[id] === mode) return;
  state.settings.quantModes[id] = mode;
  log(state, 'system', `${quantName(id)} set to ${mode}.`);
}

export function halt(state) {
  if (state.kill.halted) return;
  const open = pending(state);
  for (const o of open) o.status = 'cancelled';
  state.kill = { halted: true, at: `${state.sim.day} ${clock(state)}` };
  log(state, 'halt', `Kill switch pressed. ${open.length} pending order${open.length === 1 ? '' : 's'} cancelled.`);
}
export function resume(state) {
  if (!state.kill.halted) return;
  state.kill = { halted: false };
  log(state, 'system', 'Trading resumed. Quants run again at the next open.');
}

// One five-minute step. At the close: expire unapproved orders, grade due calls, roll the day.
export function tick(state) {
  openDay(state);
  const { closed } = step(state.sim);
  const eq = totals(state).equity;
  state.curve.intraday.push(eq);
  state.peakEquity = Math.max(state.peakEquity, eq);
  autoRun(state);
  if (closed) closeDay(state);
}

export function closeDay(state) {
  const expired = pending(state);
  for (const o of expired) o.status = 'expired';
  const eq = totals(state).equity;
  state.curve.daily.push({ date: state.sim.day, equity: eq, spy: state.sim.prices.SPY });
  if (state.curve.daily.length > 400) state.curve.daily.shift();
  log(state, 'system', `Market close. NAV ${usd(eq)} (${pct(eq / state.startOfDayEquity - 1)} today).` +
    (expired.length ? ` ${expired.length} unapproved order${expired.length > 1 ? 's' : ''} expired.` : ''));
  openNextDay(state.sim);
  gradeDue(state);
  openDay(state);
}

// Grades open calls whose horizon has passed, using simulated closes.
export function gradeDue(state) {
  let n = 0;
  for (const s of state.signals) {
    if (s.status !== 'open') continue;
    const r = gradeSignal(s, closesAfter(state.sim, s.symbol, s.issuedOn), closesAfter(state.sim, s.benchmark, s.issuedOn));
    if (!r) continue;
    s.status = 'graded'; s.result = r; n++;
  }
  if (n) log(state, 'system', `Graded ${n} call${n > 1 ? 's' : ''} that reached their 63-day horizon.`);
  return n;
}

// Runs to the next close without rendering in between.
export function skipToClose(state) {
  openDay(state);
  while (marketOpen(state)) {
    const { closed } = step(state.sim);
    const eq = totals(state).equity;
    state.curve.intraday.push(eq);
    state.peakEquity = Math.max(state.peakEquity, eq);
    autoRun(state);
    if (closed) { closeDay(state); break; }
  }
}

// ---------- formatting shared by screens

export const usd = (v, d = 0) => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (v, d = 2) => (v > 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
export const fmtQty = o => (CRYPTO.includes(o.symbol) ? (+(+o.qty).toFixed(4)).toString() : String(o.qty));
