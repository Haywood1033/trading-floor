// The fund: state plus every action the manager or the desk can take. No DOM here, so it is
// tested in Node and shared by every screen.
//
// Every fill goes through fill(), which always runs the risk manager first (kill switch
// included). There is no other path that changes positions or cash.

import * as synthetic from './sim.js';
import * as replay from './replay.js';
import { TICKS_PER_DAY } from './sim.js';
import { runRotation, rankUniverse } from '../src/quants/rotation.js';
import { ROTATION_UNIVERSE, metaFor } from '../src/data/universe.js';
import { mrSignals, RULES as MR_RULES } from '../src/quants/meanReversion.js';
import { cryptoSignals, COINS, RULES as CRY_RULES } from '../src/quants/cryptoTrend.js';
import { sampleBars } from '../src/data/sample.js';
import { reviewPortfolio } from '../src/quants/portfolioReviewer.js';
import { runMomentum, DEFAULT_UNIVERSE } from '../src/quants/momentum.js';
import { evaluateOrder, canAutoExecute, maxQtyWithinLimits } from '../src/risk/riskManager.js';
import { createTracker, gradeSignal } from '../src/tracking/tracker.js';
import { summarize } from '../src/core/portfolio.js';
import { DEFAULT_LIMITS } from '../src/risk/limits.js';
import { sectorOf } from '../src/core/sectors.js';

export const STATE_VERSION = 3; // 3: real-history replay
const { createSim } = synthetic;

// The market behind a fund: real-history replay, or the synthetic simulator (fallback/tests).
const M = sim => (sim.mode === 'replay' ? replay : synthetic);
const step = sim => M(sim).step(sim);
const openNextDay = sim => M(sim).openNextDay(sim);
const closesAfter = (sim, sym, date) => M(sim).closesAfter(sim, sym, date);

// Real price history, loaded once by the app (state/history) and shared by every fund.
let MARKET = null;
export const setMarket = hist => { MARKET = hist; };
export const market = () => MARKET;
export const isReplay = state => state.sim.mode === 'replay';
export const REBALANCE_DAYS = 21;
export const CRYPTO = ['BTC', 'ETH', 'SOL'];
export const QUANTS = [
  { id: 'rev', name: 'Portfolio reviewer', desc: 'Flags stale holdings and oversized positions; proposes sells and trims.' },
  { id: 'mom', name: 'Momentum', desc: 'Buys 12-1 month return leaders above their 200-day average, ~5% each.' },
  { id: 'mr', name: 'Mean reversion', desc: 'Buys sharp dips (RSI 2 under 10) in funds above their 200-day average; sells on the bounce or after 10 days.' },
  { id: 'cry', name: 'Crypto trend', desc: 'Holds BTC and ETH only while each is above its 200-day average; checked weekly.' }
];
// Days after a call it is graded: matches how long each quant expects to hold.
export const HORIZON = { rev: 63, mom: 63, mr: 10, cry: 21 };
// Share of the fund each quant sizes its positions from (replay funds). The hard cap that the
// risk check enforces is the sleeve plus SLEEVE_SLACK, so price drift doesn't block top-ups.
export const DEFAULT_SLEEVES = { mom: 0.60, mr: 0.20, cry: 0.15 };
export const SLEEVE_SLACK = 0.05;
const QUANT_OWNED = ['mom', 'mr', 'cry'];
export const quantName = id => (id === 'manager' ? 'Manager' : QUANTS.find(q => q.id === id)?.name || id);
// Most of the fund each quant's positions may hold (buys beyond it are blocked). null = no cap.
export const DEFAULT_ALLOC = { rev: null, mom: 0.6 };

// Fills in fields added after a fund was first saved, so older saved funds keep working.
export function migrate(state) {
  if (state.sim.mode === 'replay' && !state.sim.hist) {
    if (!MARKET) throw new Error('Price history is not loaded');
    replay.attach(state.sim, MARKET);
  }
  state.daysRun ??= state.curve.daily.length;
  state.nextRebalance ??= 0;
  state.nextCrypto ??= 0;
  state.paperBook ??= { mr: {}, cry: {} };
  for (const p of Object.values(state.account.positions)) {
    p.owners ??= { [p.openedBy || 'manager']: p.qty };
    p.since ??= { [p.openedBy || 'manager']: p.openedRun ?? 0 };
  }
  if (state.sim.mode === 'replay') {
    state.settings.sleeves ??= { ...DEFAULT_SLEEVES };
    state.settings.quantModes.mr ??= 'paper';
    state.settings.quantModes.cry ??= 'live';
    for (const id of ['mom', 'mr', 'cry']) state.settings.quantAlloc[id] ??= +(state.settings.sleeves[id] + SLEEVE_SLACK).toFixed(4);
  } else {
    state.settings.quantModes.mr ??= 'off';
    state.settings.quantModes.cry ??= 'off';
  }
  state.peakEquity ??= Math.max(state.fund.capital, ...state.curve.daily.map(d => d.equity));
  state.fund.spyStart ??= state.sim.prices.SPY;
  state.settings.quantAlloc ??= { ...DEFAULT_ALLOC };
  state.settings.limits = { ...defaultLimitsFor(state.fund.capital, { replay: isReplay(state) }), ...state.settings.limits };
  return state;
}

export const DEFAULT_CAPITAL = 1000;

// Default limits scaled to the fund: percentages as in DEFAULT_LIMITS, dollar limits as a
// share of starting capital, and a minimum trade so tiny orders aren't proposed.
export function defaultLimitsFor(capital, { replay = false } = {}) {
  return {
    ...structuredClone(DEFAULT_LIMITS),
    // The rotation buys about a third of the fund per fund held; the order cap leaves room for that.
    maxOrderValue: Math.round(capital * (replay ? 0.40 : 0.20)),
    autoMaxOrderValue: Math.round(capital * 0.10),
    minOrderValue: Math.max(1, Math.round(capital * 0.005)),
    // The backtest has no sector caps; the replay starts without them so it trades the same strategy.
    ...(replay ? { sectorLimits: {} } : {})
  };
}

// A fund on real history, starting on startDate.
export function freshReplayState({ hist = MARKET, startDate, capital = DEFAULT_CAPITAL, seed = 7 } = {}) {
  if (!hist) throw new Error('Price history is not loaded');
  const sim = replay.createReplay(hist, { startDate, seed });
  return {
    version: STATE_VERSION,
    fund: { name: 'Trading Floor', capital, inception: sim.day, spyStart: sim.prices.SPY, replay: true },
    sim,
    account: { cash: capital, positions: {}, realized: 0 },
    startOfDayEquity: capital, peakEquity: capital, openedDay: null, daysRun: 0, nextRebalance: 0, nextCrypto: 0, paperBook: { mr: {}, cry: {} },
    orders: [], signals: [], log: [], kill: { halted: false },
    settings: { mode: 'approval', speed: 1, limits: defaultLimitsFor(capital, { replay: true }), quantModes: { rev: 'live', mom: 'live', mr: 'paper', cry: 'live' },
      sleeves: { ...DEFAULT_SLEEVES },
      quantAlloc: { rev: null, ...Object.fromEntries(Object.entries(DEFAULT_SLEEVES).map(([k, v]) => [k, +(v + SLEEVE_SLACK).toFixed(4)])) } },
    curve: { intraday: [capital], daily: [] },
    seq: 1
  };
}

export function freshState({ startDate = '2026-10-14', capital = DEFAULT_CAPITAL, seed = 20261014 } = {}) {
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
    settings: { mode: 'approval', speed: 1, limits: defaultLimitsFor(capital), quantModes: { rev: 'live', mom: 'live' }, quantAlloc: { ...DEFAULT_ALLOC } },
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
export const marketOpen = state => !state.sim.ended && state.sim.tick < TICKS_PER_DAY;
export const assetClassOf = sym => (CRYPTO.includes(sym) ? 'crypto' : metaFor(sym) ? 'etf' : 'stock');
export const sectorFor = sym => metaFor(sym)?.sector || sectorOf(sym, assetClassOf(sym));
export const universe = state => (isReplay(state) ? ROTATION_UNIVERSE.filter(s => state.sim.history[s]) : DEFAULT_UNIVERSE);
// The single-position cap that applies to a holding: ETFs have their own (diversified funds),
// crypto is capped as a group instead, everything else uses the single-stock cap.
export function positionCap(state, p) {
  const L = state.settings.limits;
  return p.assetClass === 'crypto' ? null : p.assetClass === 'etf' ? (L.maxEtfPct ?? L.maxPositionPct) : L.maxPositionPct;
}
// The holding closest to its cap: { sym, weight, cap } or null.
export function largestVsCap(state) {
  const t = totals(state);
  let best = null;
  for (const [sym, p] of Object.entries(state.account.positions)) {
    const cap = positionCap(state, p);
    if (cap == null) continue;
    const weight = p.qty * state.sim.prices[sym] / t.equity;
    if (!best || weight / cap > best.weight / best.cap) best = { sym, weight, cap };
  }
  return best;
}
export const daysToRebalance = state => Math.max(0, (state.nextRebalance ?? 0) - (state.daysRun ?? 0));
export function rotationView(state) {
  return rankUniverse(state.sim.history, universe(state));
}
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

// ---------- position ownership
// A position can be shared: each quant (or 'manager') owns part of it. owners: { id: qty },
// since: { id: daysRun when that owner first bought }.
export const ownersOf = p => p.owners || { [p.openedBy || 'manager']: p.qty };
export const ownedQty = (state, sym, id) => ownersOf(state.account.positions[sym] || { owners: {} })[id] || 0;

// ---------- quant capital allocation

export function quantExposure(state, quantId) {
  let v = 0;
  for (const [sym, p] of Object.entries(state.account.positions)) v += (ownersOf(p)[quantId] || 0) * state.sim.prices[sym];
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
  const min = state.settings.limits.minOrderValue;
  if (min && order.side === 'buy' && order.qty * order.price < min) r.checks.push({ id: 'minOrder', ok: false, message: `Order under the $${min} minimum` });
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
// Size step for the +/- buttons and resize-to-fit: about a dollar or two per step at these prices.
export const stepFor = symbol => (CRYPTO.includes(symbol) ? (symbol === 'BTC' ? 0.00001 : symbol === 'ETH' ? 0.0001 : 0.01) : 0.001);
const roundQty = q => +(+q).toFixed(5);
// +/- buttons move an order by about 1% of the fund, in whole steps.
export function nudge(state, o) {
  const st = stepFor(o.symbol);
  return roundQty(Math.max(st, Math.round(state.fund.capital * 0.01 / state.sim.prices[o.symbol] / st) * st));
}

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
  const replayFund = isReplay(state);
  const owned = id => Object.fromEntries(Object.entries(state.account.positions).map(([sym, p]) => [sym, ownersOf(p)[id] || 0]).filter(([, q]) => q > 0));
  // The part of each position no quant owns (your own trades): what the reviewer reviews.
  const notQuantOwned = { ...snap, positions: Object.fromEntries(Object.entries(snap.positions).map(([sym, p]) => {
    const quantQty = QUANT_OWNED.reduce((a, id) => a + (ownersOf(p)[id] || 0), 0);
    return [sym, { ...p, qty: +(p.qty - quantQty).toFixed(6), costBasis: p.costBasis * (1 - quantQty / p.qty) }];
  }).filter(([, p]) => p.qty > 1e-9)) };
  const equity = totals(state).equity;
  const sleeve = id => equity * (state.settings.sleeves?.[id] ?? 0);
  const minOrder = state.settings.limits.minOrderValue || 0;
  const live = id => state.settings.quantModes[id] === 'live';
  // Positions a quant holds: real ones when live, its paper book when on paper.
  const book = id => live(id)
    ? Object.fromEntries(Object.entries(state.account.positions).filter(([, p]) => (ownersOf(p)[id] || 0) > 0).map(([sym, p]) => [sym, { qty: ownersOf(p)[id], since: p.since?.[id] ?? p.openedRun ?? state.daysRun }]))
    : Object.fromEntries(Object.entries(state.paperBook[id] || {}).map(([sym, since]) => [sym, { qty: 0, since }]));
  const buyQty = (sym, dollars) => Math.floor(dollars / state.sim.prices[sym] * 1000) / 1000;
  const runs = {
    // The reviewer watches what the quants don't own (your own trades), in replay funds.
    rev: () => reviewPortfolio(replayFund ? notQuantOwned : snap, bars, { limits: state.settings.limits, fractional: true }).proposals,
    mom: () => {
      if (!replayFund) return runMomentum(snap, bars, { universe: DEFAULT_UNIVERSE, fractional: true, minOrderValue: state.settings.limits.minOrderValue || 0 }).proposals;
      if (state.daysRun < state.nextRebalance) return null;                     // not a rebalance day
      state.nextRebalance = state.daysRun + REBALANCE_DAYS;
      return runRotation(snap, bars, { universe: universe(state), held: owned('mom'), cashBuffer: 1 - (state.settings.sleeves?.mom ?? 0.94), minOrderValue: minOrder, metaFor }).proposals;
    },
    mr: () => {
      if (!replayFund) return null;
      const held = book('mr');
      const days = Object.fromEntries(Object.entries(held).map(([s, h]) => [s, state.daysRun - h.since]));
      const { exits, entries } = mrSignals(bars, universe(state), days);
      if (!live('mr')) {                                 // paper: keep the paper book in step
        for (const e of exits) delete state.paperBook.mr[e.symbol];
        for (const e of entries) state.paperBook.mr[e.symbol] = state.daysRun;
      }
      const per = sleeve('mr') / MR_RULES.maxPositions;
      return [
        ...exits.filter(e => held[e.symbol].qty > 0).map(e => ({ quantId: 'mr', symbol: e.symbol, side: 'sell', qty: held[e.symbol].qty, assetClass: 'etf', record: false, confidence: 0.55,
          thesis: `Mean reversion exit: ${e.symbol} ${e.why}. Sell all.` })),
        ...entries.map(e => ({ quantId: 'mr', symbol: e.symbol, side: 'buy', qty: buyQty(e.symbol, per), assetClass: 'etf', confidence: 0.52,
          thesis: `Mean reversion entry: ${e.symbol} (${metaFor(e.symbol)?.name || ''}) ${e.why}. Buy ~$${Math.round(per)} (a third of the mean reversion sleeve); exits on the bounce or after ${MR_RULES.maxHoldDays} days.` }))
          .filter(p => p.qty * state.sim.prices[p.symbol] >= minOrder)
      ];
    },
    cry: () => {
      if (!replayFund) return null;
      if (state.daysRun < (state.nextCrypto ?? 0)) return null;           // weekly check
      state.nextCrypto = state.daysRun + CRY_RULES.everyDays;
      const coins = COINS.filter(c => (bars[c]?.length || 0) > CRY_RULES.trendDays);
      if (!coins.length) return [];
      const { want, scan } = cryptoSignals(bars, coins);
      const held = book('cry');
      const per = sleeve('cry') / coins.length;
      const info = sym => { const x = scan.find(y => y.symbol === sym); return `price ${usd(x.price)} vs 200-day average ${usd(x.average)}`; };
      const out = [];
      for (const sym of Object.keys(held)) if (!want.includes(sym)) {
        if (!live('cry')) delete state.paperBook.cry[sym];
        if (held[sym].qty > 0) out.push({ quantId: 'cry', symbol: sym, side: 'sell', qty: held[sym].qty, assetClass: 'crypto', confidence: 0.55, thesis: `Crypto trend exit: ${sym} fell below its 200-day average (${info(sym)}). Sell all; hold cash until it recovers.` });
      }
      for (const sym of want) if (!held[sym]) {
        if (!live('cry')) state.paperBook.cry[sym] = state.daysRun;
        const qty = Math.floor(per / state.sim.prices[sym] * 1e5) / 1e5;
        if (qty * state.sim.prices[sym] >= minOrder) out.push({ quantId: 'cry', symbol: sym, side: 'buy', qty, assetClass: 'crypto', confidence: 0.55, thesis: `Crypto trend: ${sym} is above its 200-day average (${info(sym)}). Buy ~$${Math.round(per)} (its share of the crypto sleeve); held until it closes below the average on a weekly check.` });
      }
      return out;
    }
  };
  const t = tracker(state);
  for (const q of QUANTS) {
    const mode = state.settings.quantModes[q.id];
    if (mode === 'off') continue;
    const proposals = runs[q.id]();
    if (proposals === null) continue;
    if (!proposals.length) { log(state, 'signal', `${q.name}: nothing to propose.`); continue; }
    let queued = 0;
    for (const p of proposals) {
      p.price = state.sim.prices[p.symbol];
      const benchmark = p.assetClass === 'crypto' && p.symbol !== 'BTC' ? 'BTC' : 'SPY';
      if (p.record !== false) t.record(p, { benchmark, benchEntry: state.sim.prices[benchmark], issuedOn: state.sim.day, horizonDays: HORIZON[q.id] ?? 63 });
      if (mode === 'paper') continue;
      if (pending(state).some(o => o.symbol === p.symbol && o.side === p.side && o.quantId === q.id)) continue;
      state.orders.push({
        id: state.seq++, status: 'pending', created: state.sim.day, quantId: q.id,
        symbol: p.symbol, side: p.side, qty: p.qty, proposedQty: p.qty, sector: p.sector || sectorFor(p.symbol),
        assetClass: p.assetClass || assetClassOf(p.symbol), confidence: p.confidence, thesis: p.thesis
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
    const owners = pos ? { ...ownersOf(pos) } : {};
    owners[o.quantId] = +((owners[o.quantId] || 0) + o.qty).toFixed(6);
    const since = { ...(pos?.since || {}) };
    since[o.quantId] ??= state.daysRun;
    a.positions[o.symbol] = pos
      ? { ...pos, qty: +(pos.qty + o.qty).toFixed(6), costBasis: pos.costBasis + value, owners, since }
      : { qty: o.qty, costBasis: value, sector: o.sector, assetClass: o.assetClass, opened: state.sim.day, openedBy: o.quantId, openedRun: state.daysRun, owners, since };
  } else {
    const basisOut = pos.costBasis * (o.qty / pos.qty);
    realized = value - basisOut;
    o.realized = realized;
    // The seller's own shares go first; anything beyond that comes out of the other owners pro rata.
    const owners = { ...ownersOf(pos) };
    const fromSeller = Math.min(owners[o.quantId] || 0, o.qty);
    o.attribution = fromSeller > 0 ? o.quantId : (pos.openedBy || 'manager');
    if (fromSeller) owners[o.quantId] = +(owners[o.quantId] - fromSeller).toFixed(6);
    let rest = o.qty - fromSeller;
    const others = Object.values(owners).reduce((x, y) => x + y, 0);
    if (rest > 1e-9 && others > 0) for (const k of Object.keys(owners)) owners[k] = +(owners[k] - rest * owners[k] / others).toFixed(6);
    const since = { ...(pos.since || {}) };
    for (const k of Object.keys(owners)) if (owners[k] <= 1e-9) { delete owners[k]; delete since[k]; }
    a.realized += realized;
    a.cash += value;
    const left = +(pos.qty - o.qty).toFixed(6);
    if (left <= 1e-9) delete a.positions[o.symbol];
    else a.positions[o.symbol] = { ...pos, qty: left, costBasis: pos.costBasis - basisOut, owners, since };
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
  o.qty = roundQty(qty);
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
  const assetClass = assetClassOf(symbol);
  const o = {
    id: state.seq++, status: 'pending', created: state.sim.day, quantId: 'manager', symbol, side, qty: +qty.toFixed(6), proposedQty: qty,
    sector: state.account.positions[symbol]?.sector || sectorFor(symbol), assetClass, confidence: null, thesis: 'Manager ticket.'
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
  const assetClass = assetClassOf(symbol);
  const o = { quantId: 'manager', symbol, side, qty: +qty, price: state.sim.prices[symbol], sector: state.account.positions[symbol]?.sector || sectorFor(symbol), assetClass };
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
  state.settings.limits = defaultLimitsFor(state.fund.capital, { replay: isReplay(state) });
  log(state, 'system', 'Risk limits reset to defaults.');
}
// Sets a quant's sleeve (share of the fund it sizes from) and its hard cap (sleeve + slack).
export function setSleeve(state, id, value) {
  const old = state.settings.sleeves[id];
  if (old === value) return;
  state.settings.sleeves[id] = value;
  state.settings.quantAlloc[id] = +(value + SLEEVE_SLACK).toFixed(4);
  log(state, 'system', `${quantName(id)} sleeve ${(old * 100).toFixed(0)}% → ${(value * 100).toFixed(0)}% of the fund.`);
}
export const sleeveTotal = state => Object.values(state.settings.sleeves || {}).reduce((a, b) => a + b, 0);

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
  state.daysRun = (state.daysRun || 0) + 1;
  openNextDay(state.sim);
  gradeDue(state);
  if (state.sim.ended) { log(state, 'system', `Replay reached the latest data (${state.sim.day}). The market stays closed until the history updates.`); return; }
  openDay(state);
}

// Runs up to n whole trading days, but stops at the first market open where new proposals are
// waiting, so a skip never lets the quants' proposals expire unseen. Returns days run.
export function skipDays(state, n) {
  let i = 0;
  while (i < n && !state.sim.ended) {
    skipToClose(state);
    i++;
    if (pending(state).length) break;
  }
  return i;
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
export const fmtQty = o => String(+(+o.qty).toFixed(CRYPTO.includes(o.symbol) ? 5 : 3));
