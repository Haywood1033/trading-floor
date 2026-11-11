// The fund: state plus every action the manager or the desk can take. No DOM here, so it is
// tested in Node and shared by every screen.
//
// A day works like the backtest (src/portfolioBacktest.js): at each close the quants look at
// closes up to that day and propose orders. You (or auto mode, within its rules) approve them,
// and approved orders fill at the NEXT close, after the risk manager checks them again at that
// price, paying trading costs. Unanswered proposals expire at the next close; an unanswered
// rotation is proposed again then. There is no other path that changes positions or cash.

import * as replay from './replay.js';
import { runRotation, rankUniverse } from '../src/quants/rotation.js';
import { ROTATION_UNIVERSE, metaFor } from '../src/data/universe.js';
import { mrSignals, RULES as MR_RULES } from '../src/quants/meanReversion.js';
import { cryptoSignals, COINS, RULES as CRY_RULES } from '../src/quants/cryptoTrend.js';
import { reviewPortfolio } from '../src/quants/portfolioReviewer.js';
import { evaluateOrder, canAutoExecute, maxQtyWithinLimits, orderCap, autoCap } from '../src/risk/riskManager.js';
import { createTracker, gradeSignal } from '../src/tracking/tracker.js';
import { summarize, applyOrder } from '../src/core/portfolio.js';
import { DEFAULT_LIMITS } from '../src/risk/limits.js';
import { sectorOf } from '../src/core/sectors.js';

export const STATE_VERSION = 4; // 4: daily engine (decide at close, fill at next close)

// Real price history, loaded once by the app (state/history) and shared by every fund.
let MARKET = null;
export const setMarket = hist => { MARKET = hist; };
export const market = () => MARKET;
export const isReplay = () => true;
export const REBALANCE_DAYS = 21;
export const CRYPTO = ['BTC', 'ETH', 'SOL'];
export const QUANTS = [
  { id: 'rev', name: 'Portfolio reviewer', desc: 'Reviews your own positions: flags stale holdings and oversized positions; proposes sells and trims.' },
  { id: 'mom', name: 'Momentum rotation', desc: 'Holds the top 3 of 20 ETFs by 12-1 month return, above their 200-day average; rebalances every 21 trading days and trims winners past their share.' },
  { id: 'mr', name: 'Mean reversion', desc: 'Buys sharp dips (RSI 2 under 10) in funds above their 200-day average; sells on the bounce or after 10 days.' },
  { id: 'cry', name: 'Crypto trend', desc: 'Holds BTC and ETH only while each is above its 200-day average; checked weekly.' }
];
// Days after a call it is graded: matches how long each quant expects to hold.
export const HORIZON = { rev: 63, mom: 63, mr: 10, cry: 21 };
// Share of the fund each quant sizes its positions from. The hard cap that the risk check
// enforces is the sleeve plus SLEEVE_SLACK, so price drift doesn't block top-ups.
export const DEFAULT_SLEEVES = { mom: 0.60, mr: 0.20, cry: 0.15 };
export const SLEEVE_SLACK = 0.05;
const QUANT_OWNED = ['mom', 'mr', 'cry'];
export const quantName = id => (id === 'manager' ? 'Manager' : QUANTS.find(q => q.id === id)?.name || id);
export const DEFAULT_CAPITAL = 1000;
export const DEFAULT_COST_BPS = 10;          // spread and slippage per trade, as the backtest
export const LOG_LIMIT = 5000;               // log entries kept (newest first)
export const CURVE_LIMIT = 20000;            // daily NAV points kept (about 80 years)
// Trading cost for a symbol: short Treasuries trade for about 1 bp, everything else costBps.
export const costBpsFor = (state, sym) => (sym === 'SHY' ? 1 : state.settings.costBps ?? DEFAULT_COST_BPS);

// Default limits for a fund: the percentages in DEFAULT_LIMITS (order caps are a share of
// NAV, so they grow and shrink with the fund), no sector caps (the backtest has none), and a
// minimum trade so tiny orders aren't proposed.
export function defaultLimitsFor(capital) {
  return { ...structuredClone(DEFAULT_LIMITS), sectorLimits: {}, minOrderValue: Math.max(1, Math.round(capital * 0.005)) };
}

const defaultAlloc = () => ({ rev: null, ...Object.fromEntries(Object.entries(DEFAULT_SLEEVES).map(([k, v]) => [k, +(v + SLEEVE_SLACK).toFixed(4)])) });

// A fund on real history. It starts at the close of startDate with all cash; call decide() to
// have the quants look at that close.
export function freshReplayState({ hist = MARKET, startDate, capital = DEFAULT_CAPITAL } = {}) {
  if (!hist) throw new Error('Price history is not loaded');
  const sim = replay.createReplay(hist, { startDate });
  return {
    version: STATE_VERSION,
    fund: { name: 'Trading Floor', capital, inception: sim.day, spyStart: sim.prices.SPY, replay: true },
    sim,
    account: { cash: capital, positions: {}, realized: 0, dividends: 0, fees: 0 },
    prevEquity: capital, peakEquity: capital, drawdownPeak: capital, breaker: null,
    decidedOn: null, daysRun: 0, nextRebalance: 0, nextCrypto: 0, paperBook: { mr: {}, cry: {} },
    orders: [], signals: [], log: [], kill: { halted: false },
    settings: {
      mode: 'approval', speed: 'pause', costBps: DEFAULT_COST_BPS, rotationBand: 0.10,
      limits: defaultLimitsFor(capital),
      quantModes: { rev: 'live', mom: 'live', mr: 'paper', cry: 'live' },
      sleeves: { ...DEFAULT_SLEEVES }, quantAlloc: defaultAlloc()
    },
    curve: { daily: [{ date: sim.day, equity: capital, spy: sim.prices.SPY }] },
    seq: 1
  };
}

// Brings a saved fund up to date and reattaches the price history (not saved with the fund).
// Version 3 funds (five-minute intraday clock) are converted: they continue from the last
// close they completed; orders that were waiting expire; dollar order caps become shares of NAV.
export function migrate(state) {
  if (!MARKET) throw new Error('Price history is not loaded');
  if (state.version === 3) {
    const sim = state.sim;
    const cursor = Math.max(0, Math.min(sim.cursor - 1, MARKET.dates.length - 1));
    state.sim = { mode: 'replay', cursor, day: MARKET.dates[cursor], ended: false, prices: {} };
    for (const o of state.orders) if (o.status === 'pending') o.status = 'expired';
    const L = state.settings.limits || {};
    const cap = state.fund.capital;
    if (L.maxOrderValue != null && L.maxOrderPct == null) L.maxOrderPct = +(L.maxOrderValue / cap).toFixed(4);
    if (L.autoMaxOrderValue != null && L.autoMaxOrderPct == null) L.autoMaxOrderPct = +(L.autoMaxOrderValue / cap).toFixed(4);
    L.maxOrderValue = null; L.autoMaxOrderValue = null;
    delete state.startOfDayEquity; delete state.openedDay;
    if (state.curve) delete state.curve.intraday;
    state.settings.speed = 'pause';
    state.version = 4;
  }
  replay.attach(state.sim, MARKET);
  if (typeof state.settings.speed !== 'string') state.settings.speed = 'pause';
  state.daysRun ??= state.curve.daily.length;
  state.nextRebalance ??= 0;
  state.nextCrypto ??= 0;
  state.paperBook ??= { mr: {}, cry: {} };
  state.account.dividends ??= 0;
  state.account.fees ??= 0;
  for (const p of Object.values(state.account.positions)) {
    p.owners ??= { [p.openedBy || 'manager']: p.qty };
    p.since ??= { [p.openedBy || 'manager']: p.openedRun ?? 0 };
  }
  state.settings.sleeves ??= { ...DEFAULT_SLEEVES };
  state.settings.quantModes.mr ??= 'paper';
  state.settings.quantModes.cry ??= 'live';
  state.settings.quantAlloc ??= defaultAlloc();
  for (const id of QUANT_OWNED) if (!(id in state.settings.quantAlloc)) state.settings.quantAlloc[id] = +(state.settings.sleeves[id] + SLEEVE_SLACK).toFixed(4);
  state.settings.costBps ??= DEFAULT_COST_BPS;
  state.settings.rotationBand ??= 0.10;
  state.settings.limits = { ...defaultLimitsFor(state.fund.capital), ...state.settings.limits };
  const eq = totals(state).equity;
  state.prevEquity ??= eq;
  state.peakEquity ??= Math.max(state.fund.capital, ...state.curve.daily.map(d => d.equity));
  state.drawdownPeak ??= state.peakEquity;
  state.breaker ??= null;
  state.decidedOn ??= null;
  state.fund.spyStart ??= state.sim.prices.SPY;
  if (state.log.length > LOG_LIMIT) state.log.length = LOG_LIMIT;
  return state;
}

// ---------- reads

export function snapshot(state) {
  const positions = {};
  for (const [s, p] of Object.entries(state.account.positions)) positions[s] = { ...p, price: state.sim.prices[s] };
  return { cash: state.account.cash, positions, startOfDayEquity: state.prevEquity };
}
export const totals = state => summarize(snapshot(state));
// Orders can be approved until the history runs out.
export const marketOpen = state => !state.sim.ended;
export const assetClassOf = sym => (CRYPTO.includes(sym) ? 'crypto' : metaFor(sym) ? 'etf' : 'stock');
export const sectorFor = sym => metaFor(sym)?.sector || sectorOf(sym, assetClassOf(sym));
export const universe = state => ROTATION_UNIVERSE.filter(s => state.sim.history[s]);
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
export const rotationView = state => rankUniverse(state.sim.history, universe(state));
export const pending = state => state.orders.filter(o => o.status === 'pending');
// Approved, waiting for the next close.
export const approved = state => state.orders.filter(o => o.status === 'approved');
export const working = approved;
export const breakerActive = state => !!state.breaker;
export const orderCapNow = state => orderCap(state.settings.limits, snapshot(state));
export const autoCapNow = state => autoCap(state.settings.limits, snapshot(state));
// The next trading date after the current one, if the history has it.
export const nextDate = (state, n = 1) => state.sim.hist.dates[state.sim.cursor + n] || null;

const ctx = (state, order) => ({
  limits: state.settings.limits, halted: state.kill.halted, breaker: state.breaker,
  dayTradesUsed: dayTradesUsed(state), opensDayTrade: order ? opensDayTrade(state, order) : false
});

// ---------- compliance helpers (day trades, wash sales)

const fillsOn = (state, day) => state.orders.filter(o => o.status === 'filled' && o.filledAt === day);
// A day trade: buying and selling the same symbol on the same day.
export function opensDayTrade(state, order) {
  return fillsOn(state, state.sim.day).some(o => o.symbol === order.symbol && o.side !== order.side);
}
export function dayTradeLog(state) {
  const out = [];
  for (const day of state.sim.dates.slice(-5)) {
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
  return fills.filter(o => o.side === 'sell' && o.realized < 0 && o.assetClass !== 'crypto' && today - dayNum(o.filledAt) <= 30)
    .map(o => {
      const t = dayNum(o.filledAt);
      const rebuy = fills.find(b => b.side === 'buy' && b.symbol === o.symbol && b.id !== o.id && Math.abs(dayNum(b.filledAt) - t) <= 30);
      return { symbol: o.symbol, date: o.filledAt, loss: o.realized, rebought: rebuy ? rebuy.filledAt : null, clearOn: new Date((t + 31) * 864e5).toISOString().slice(0, 10) };
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
const priceOf = (state, o) => state.sim.prices[o.symbol];
// Approved orders other than `except` that fill before or with it: [buys, sells] value, per quant if given.
function queued(state, except, quantId) {
  let buys = 0, sells = 0;
  for (const o of approved(state)) {
    if (o.id === except?.id || (quantId && o.quantId !== quantId)) continue;
    const v = o.qty * (priceOf(state, o) || 0);
    if (o.side === 'buy') buys += v; else sells += v;
  }
  return [buys, sells];
}
function allocationCheck(state, order, atFill) {
  const cap = state.settings.quantAlloc?.[order.quantId];
  if (order.side !== 'buy' || cap == null) return null;
  const eq = totals(state).equity;
  const [qb, qs] = atFill ? [0, 0] : queued(state, order, order.quantId);
  const after = quantExposure(state, order.quantId) + qb - qs + order.qty * order.price;
  return { id: 'quantAllocation', ok: after <= cap * eq + 1e-6, message: `${quantName(order.quantId)} capital ${(after / eq * 100).toFixed(1)}% / ${(cap * 100).toFixed(0)}%` };
}

// The fund as it will look once the orders already approved for the next close (other than
// `except`) have filled: sells first, then buys, at the latest close.
function afterQueued(state, except) {
  let snap = snapshot(state);
  const q = approved(state).filter(o => o.id !== except?.id && priceOf(state, o) > 0).sort((a, b) => (a.side === 'sell' ? 0 : 1) - (b.side === 'sell' ? 0 : 1));
  for (const o of q) snap = applyOrder(snap, { ...o, price: priceOf(state, o) });
  return snap;
}

// Risk manager plus desk-level checks (quant capital, minimum trade). Before the fill, it
// counts the orders already approved for the next close.
export function evaluate(state, order, { atFill = false } = {}) {
  const snap = atFill ? snapshot(state) : afterQueued(state, order);
  const r = evaluateOrder(order, snap, ctx(state, order));
  const a = allocationCheck(state, order, atFill);
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

// Risk view of a waiting order at the latest close (it fills at the next one).
export function riskFor(state, order) {
  const o = { ...order, price: state.sim.prices[order.symbol] };
  const risk = evaluate(state, o);
  let fit = !risk.approved && o.side === 'buy' && !state.kill.halted ? fitQty(state, o) : 0;
  const autoBase = canAutoExecute(o, snapshot(state), { ...ctx(state, o), mode: state.settings.mode, quantTier: tierOf(state, o.quantId) });
  const failed = risk.checks.filter(c => !c.ok && ['quantAllocation', 'minOrder'].includes(c.id)).map(c => c.message);
  const auto = failed.length ? { auto: false, reasons: [...autoBase.reasons, ...failed] } : autoBase;
  return { ...risk, fit, auto, price: o.price, value: o.qty * o.price };
}
function fitQty(state, o) {
  const snap = afterQueued(state, o);
  const st = stepFor(o.symbol);
  let fit = maxQtyWithinLimits(o, snap, ctx(state, o), st);
  const cap = state.settings.quantAlloc?.[o.quantId];
  if (fit && cap != null) {
    const [qb, qs] = queued(state, o, o.quantId);
    const room = cap * totals(state).equity - quantExposure(state, o.quantId) - qb + qs;
    fit = Math.min(fit, Math.max(0, Math.floor(room / o.price / st) * st));
  }
  const min = state.settings.limits.minOrderValue || 0;
  return fit * o.price >= min ? +fit.toFixed(6) : 0;
}
// Size step for the +/- buttons and resize-to-fit.
export const stepFor = symbol => (CRYPTO.includes(symbol) ? (symbol === 'BTC' ? 0.00001 : symbol === 'ETH' ? 0.0001 : 0.01) : 0.001);
const roundQty = q => +(+q).toFixed(5);
// +/- buttons move an order by about 1% of the fund, in whole steps.
export function nudge(state, o) {
  const st = stepFor(o.symbol);
  const eq = totals(state).equity;
  return roundQty(Math.max(st, Math.round(eq * 0.01 / state.sim.prices[o.symbol] / st) * st));
}

// ---------- writes

export function log(state, kind, text, extra = {}) {
  state.log.unshift({ at: `${state.sim.day} close`, kind, text, ...extra });
  if (state.log.length > LOG_LIMIT) state.log.length = LOG_LIMIT;
}

// At a close: every live or paper quant looks at closes up to today. Live proposals wait for
// approval (or auto); paper calls are only recorded. Runs once per trading day.
export function decide(state) {
  if (state.decidedOn === state.sim.day || state.sim.ended) return;
  state.decidedOn = state.sim.day;
  if (state.kill.halted) { log(state, 'halt', 'Trading halted: quants not run.'); return; }

  const bars = state.sim.history;
  const prices = state.sim.prices;
  const snap = snapshot(state);
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
  const buyQty = (sym, dollars) => Math.floor(dollars / prices[sym] * 1000) / 1000;
  const runs = {
    rev: () => reviewPortfolio(notQuantOwned, bars, { limits: state.settings.limits, fractional: true }).proposals,
    mom: () => {
      if (state.daysRun < state.nextRebalance) return null;                     // not a rebalance day
      state.nextRebalance = state.daysRun + REBALANCE_DAYS;
      return runRotation(snap, bars, { universe: universe(state), held: owned('mom'), cashBuffer: 1 - (state.settings.sleeves?.mom ?? 0.6), minOrderValue: minOrder, metaFor, prices, band: state.settings.rotationBand ?? 0.10 }).proposals;
    },
    mr: () => {
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
          .filter(p => p.qty * prices[p.symbol] >= minOrder)
      ];
    },
    cry: () => {
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
        const qty = Math.floor(per / prices[sym] * 1e5) / 1e5;
        if (qty * prices[sym] >= minOrder) out.push({ quantId: 'cry', symbol: sym, side: 'buy', qty, assetClass: 'crypto', confidence: 0.55, thesis: `Crypto trend: ${sym} is above its 200-day average (${info(sym)}). Buy ~$${Math.round(per)} (its share of the crypto sleeve); held until it closes below the average on a weekly check.` });
      }
      return out;
    }
  };
  const t = tracker(state);
  for (const q of QUANTS) {
    const mode = state.settings.quantModes[q.id];
    if (!mode || mode === 'off') continue;
    const proposals = runs[q.id]();
    if (proposals === null) continue;
    if (!proposals.length) { if (q.id !== 'rev') log(state, 'signal', `${q.name}: nothing to propose.`); continue; }
    let queuedN = 0;
    for (const p of proposals) {
      p.price = prices[p.symbol];
      const benchmark = p.assetClass === 'crypto' && p.symbol !== 'BTC' ? 'BTC' : 'SPY';
      if (p.record !== false) t.record(p, { benchmark, benchEntry: prices[benchmark], issuedOn: state.sim.day, horizonDays: HORIZON[q.id] ?? 63 });
      if (mode === 'paper') continue;
      if (state.orders.some(o => (o.status === 'pending' || o.status === 'approved') && o.symbol === p.symbol && o.side === p.side && o.quantId === q.id)) continue;
      state.orders.push({
        id: state.seq++, status: 'pending', created: state.sim.day, quantId: q.id,
        symbol: p.symbol, side: p.side, qty: p.qty, proposedQty: p.qty, sector: p.sector || sectorFor(p.symbol),
        assetClass: p.assetClass || assetClassOf(p.symbol), confidence: p.confidence, thesis: p.thesis
      });
      queuedN++;
    }
    log(state, mode === 'paper' ? 'paper' : 'signal',
      mode === 'paper' ? `${q.name}: ${proposals.length} call${proposals.length > 1 ? 's' : ''} recorded on paper, not queued.`
                       : `${q.name}: ${queuedN} proposal${queuedN === 1 ? '' : 's'} for approval.`);
  }
  autoRun(state);
}

// Approval: the order fills at the next close if it still passes risk at that price.
export function approve(state, id, by = 'manager') {
  const o = state.orders.find(x => x.id === id && x.status === 'pending');
  if (!o) return { ok: false, reason: 'Order is no longer waiting for approval' };
  if (state.sim.ended) return { ok: false, reason: 'The replay has reached the latest data' };
  if (state.kill.halted) return { ok: false, reason: 'Trading is halted (kill switch)' };
  const risk = evaluate(state, { ...o, price: state.sim.prices[o.symbol] });
  if (!risk.approved) return { ok: false, reason: risk.checks.filter(c => !c.ok).map(c => c.message).join(', ') };
  Object.assign(o, { status: 'approved', approvedBy: by, approvedOn: state.sim.day });
  log(state, 'approve', `${o.side.toUpperCase()} ${fmtQty(o)} ${o.symbol} approved${by === 'auto' ? ' by auto' : ' by you'}; fills at the next close${nextDate(state) ? ' (' + nextDate(state) + ')' : ''}.`);
  return { ok: true };
}

// The only way positions and cash change: an approved order, at the current close.
function fill(state, o) {
  const price = state.sim.prices[o.symbol];
  if (!(price > 0)) { o.status = 'blocked'; o.blockedReason = 'No price today'; return false; }
  const order = { ...o, price };
  const risk = evaluate(state, order, { atFill: true });
  if (!risk.approved) {
    const failed = risk.checks.filter(c => !c.ok).map(c => c.message);
    Object.assign(o, { status: 'blocked', blockedReason: failed.join(', '), blockedOn: state.sim.day });
    log(state, 'veto', `${o.side.toUpperCase()} ${fmtQty(o)} ${o.symbol} blocked at the fill: ${failed.join(', ')}`);
    return false;
  }
  const a = state.account;
  const value = o.qty * price;
  const fee = value * costBpsFor(state, o.symbol) / 1e4;
  const pos = a.positions[o.symbol];
  let realized = null;
  if (o.side === 'buy') {
    a.cash -= value + fee;
    const owners = pos ? { ...ownersOf(pos) } : {};
    owners[o.quantId] = +((owners[o.quantId] || 0) + o.qty).toFixed(6);
    const since = { ...(pos?.since || {}) };
    since[o.quantId] ??= state.daysRun;
    a.positions[o.symbol] = pos
      ? { ...pos, qty: +(pos.qty + o.qty).toFixed(6), costBasis: pos.costBasis + value + fee, owners, since }
      : { qty: o.qty, costBasis: value + fee, sector: o.sector, assetClass: o.assetClass, opened: state.sim.day, openedBy: o.quantId, openedRun: state.daysRun, owners, since };
  } else {
    const qty = Math.min(o.qty, pos.qty);
    o.qty = qty;
    const basisOut = pos.costBasis * (qty / pos.qty);
    realized = value - fee - basisOut;
    o.realized = realized;
    // The seller's own shares go first; anything beyond that comes out of the other owners pro rata.
    const owners = { ...ownersOf(pos) };
    const fromSeller = Math.min(owners[o.quantId] || 0, qty);
    o.attribution = fromSeller > 0 ? o.quantId : (pos.openedBy || 'manager');
    if (fromSeller) owners[o.quantId] = +(owners[o.quantId] - fromSeller).toFixed(6);
    const rest = qty - fromSeller;
    const others = Object.values(owners).reduce((x, y) => x + y, 0);
    if (rest > 1e-9 && others > 0) for (const k of Object.keys(owners)) owners[k] = +(owners[k] - rest * owners[k] / others).toFixed(6);
    const since = { ...(pos.since || {}) };
    for (const k of Object.keys(owners)) if (owners[k] <= 1e-9) { delete owners[k]; delete since[k]; }
    a.realized += realized;
    a.cash += value - fee;
    const left = +(pos.qty - qty).toFixed(6);
    if (left <= 1e-9) delete a.positions[o.symbol];
    else a.positions[o.symbol] = { ...pos, qty: left, costBasis: pos.costBasis - basisOut, owners, since };
  }
  a.fees += fee;
  Object.assign(o, { status: 'filled', filledAt: state.sim.day, fillPrice: price, fee });
  log(state, 'fill', `${o.side.toUpperCase()} ${fmtQty(o)} ${o.symbol} @ ${usd(price, 2)} (${usd(value)}, cost ${usd(fee, 2)})` +
    (realized != null ? `, realized ${realized >= 0 ? '+' : ''}${usd(realized)}` : '') + (o.approvedBy === 'auto' ? ', auto' : ''));
  return true;
}

export function reject(state, id) {
  const o = state.orders.find(x => x.id === id && x.status === 'pending');
  if (!o) return;
  o.status = 'rejected';
  log(state, 'reject', `${o.side.toUpperCase()} ${fmtQty(o)} ${o.symbol} rejected by you.`);
}
// Takes back an approval before the next close.
export function cancelOrder(state, id) {
  const o = state.orders.find(x => x.id === id && x.status === 'approved');
  if (!o) return;
  o.status = 'cancelled';
  log(state, 'reject', `${o.side.toUpperCase()} ${fmtQty(o)} ${o.symbol} cancelled before the fill.`);
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

// Manager's own trade from the ticket: same risk checks; approved at once, fills at the next close.
export function placeManual(state, { symbol, side, qty }) {
  qty = +qty;
  if (!state.sim.prices[symbol]) return { ok: false, reason: `Unknown symbol ${symbol}` };
  if (!(qty > 0)) return { ok: false, reason: 'Enter a quantity above zero' };
  const o = {
    id: state.seq++, status: 'pending', created: state.sim.day, quantId: 'manager', symbol, side, qty: +qty.toFixed(6), proposedQty: qty,
    sector: state.account.positions[symbol]?.sector || sectorFor(symbol), assetClass: assetClassOf(symbol), confidence: null, thesis: 'Manager ticket.'
  };
  state.orders.push(o);
  const r = approve(state, o.id, 'manager');
  if (!r.ok) {
    state.orders.pop(); state.seq--;
    log(state, 'veto', `Manager ${side.toUpperCase()} ${fmtQty(o)} ${symbol} blocked: ${r.reason}`);
  }
  return r;
}
export function previewManual(state, { symbol, side, qty }) {
  if (!state.sim.prices[symbol] || !(+qty > 0)) return null;
  const o = { quantId: 'manager', symbol, side, qty: +qty, price: state.sim.prices[symbol], sector: state.account.positions[symbol]?.sector || sectorFor(symbol), assetClass: assetClassOf(symbol) };
  return { ...evaluate(state, o), price: o.price, value: o.qty * o.price };
}
export function closePosition(state, symbol) {
  const held = state.account.positions[symbol]?.qty || 0;
  const selling = approved(state).filter(o => o.symbol === symbol && o.side === 'sell').reduce((a, o) => a + o.qty, 0);
  if (held - selling <= 1e-9) return { ok: false, reason: `${symbol} is already being sold at the next close` };
  return placeManual(state, { symbol, side: 'sell', qty: +(held - selling).toFixed(6) });
}

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
  state.settings.limits = defaultLimitsFor(state.fund.capital);
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

// Auto mode: approves each waiting order that its rules allow (it still fills at the next close).
export function autoRun(state) {
  if (state.settings.mode !== 'auto' || state.kill.halted || state.sim.ended) return;
  for (const o of pending(state)) if (riskFor(state, o).auto.auto) approve(state, o.id, 'auto');
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
  const open = state.orders.filter(o => o.status === 'pending' || o.status === 'approved');
  for (const o of open) o.status = 'cancelled';
  state.kill = { halted: true, at: state.sim.day };
  log(state, 'halt', `Kill switch pressed. ${open.length} waiting order${open.length === 1 ? '' : 's'} cancelled.`);
}
export function resume(state) {
  if (!state.kill.halted) return;
  state.kill = { halted: false };
  log(state, 'system', 'Trading resumed. Quants run again at the next close.');
}

// The drawdown breaker. When NAV falls maxDrawdownPct below its peak, buys pause for
// drawdownCooldownDays trading days; then the breaker re-arms from the current NAV, so the
// fund is never locked in cash for good. Sells are never blocked.
function updateBreaker(state, eq) {
  const L = state.settings.limits;
  if (state.breaker) {
    if (state.daysRun >= state.breaker.until) {
      state.breaker = null;
      state.drawdownPeak = eq;
      log(state, 'system', `Drawdown breaker re-armed after ${L.drawdownCooldownDays ?? 21} trading days. Buys allowed again; it now measures from today's NAV ${usd(eq)}.`);
    }
    return;
  }
  state.drawdownPeak = Math.max(state.drawdownPeak ?? eq, eq);
  if (L.maxDrawdownPct == null) return;
  const dd = eq / state.drawdownPeak - 1;
  if (dd <= -L.maxDrawdownPct) {
    const days = L.drawdownCooldownDays ?? 21;
    state.breaker = { trippedOn: state.sim.day, until: state.daysRun + days, untilDate: nextDate(state, days) || 'the end of the data', peak: state.drawdownPeak };
    log(state, 'halt', `Drawdown breaker tripped: NAV ${usd(eq)} is ${pct(dd)} from its peak ${usd(state.drawdownPeak)}. Buys pause for ${days} trading days (until ${state.breaker.untilDate}); sells still allowed.`);
  }
}
export function rearmBreaker(state) {
  if (!state.breaker) return;
  state.breaker = null;
  state.drawdownPeak = totals(state).equity;
  log(state, 'system', `Drawdown breaker re-armed by you. It now measures from today's NAV ${usd(state.drawdownPeak)}.`);
}

// Cash dividends to whoever held the fund at the previous close.
export function payDividends(state) {
  let total = 0;
  for (const [sym, perShare] of Object.entries(replay.dividendsToday(state.sim))) {
    const p = state.account.positions[sym];
    if (!p) continue;
    const cash = p.qty * perShare;
    state.account.cash += cash;
    state.account.dividends = (state.account.dividends || 0) + cash;
    total += cash;
    log(state, 'fill', `Dividend: ${sym} paid ${usd(perShare, 4)} a share on ${fmtQty({ symbol: sym, qty: p.qty })} (${usd(cash, 2)} cash).`);
  }
  return total;
}

// One trading day: move to the next close, pay dividends, fill approved orders (sells first),
// expire unanswered proposals, record NAV, update the breaker, grade calls, then the quants
// decide at this close. Returns false when the history has no more days.
export function advance(state) {
  decide(state);
  state.prevEquity = totals(state).equity;
  if (!replay.advance(state.sim)) {
    log(state, 'system', `Replay reached the latest data (${state.sim.day}). It continues when the price history updates.`);
    return false;
  }
  payDividends(state);
  const toFill = approved(state).sort((a, b) => (a.side === 'sell' ? 0 : 1) - (b.side === 'sell' ? 0 : 1));
  for (const o of toFill) fill(state, o);
  const expired = pending(state);
  for (const o of expired) o.status = 'expired';
  // An unanswered rotation is proposed again at this close rather than waiting a month.
  if (expired.some(o => o.quantId === 'mom')) state.nextRebalance = Math.min(state.nextRebalance, state.daysRun + 1);
  state.daysRun++;
  const eq = totals(state).equity;
  state.curve.daily.push({ date: state.sim.day, equity: eq, spy: state.sim.prices.SPY });
  if (state.curve.daily.length > CURVE_LIMIT) state.curve.daily.shift();
  state.peakEquity = Math.max(state.peakEquity, eq);
  log(state, 'system', `Close ${state.sim.day}. NAV ${usd(eq)} (${pct(eq / state.prevEquity - 1)} on the day).` +
    (expired.length ? ` ${expired.length} unanswered proposal${expired.length > 1 ? 's' : ''} expired.` : ''));
  updateBreaker(state, eq);
  gradeDue(state);
  decide(state);
  return true;
}

// Runs up to n trading days, but stops at the first close where proposals are waiting, so a
// skip never lets the quants' proposals expire unseen. Returns days run.
export function skipDays(state, n) {
  let i = 0;
  while (i < n && !state.sim.ended) {
    if (!advance(state)) break;
    i++;
    if (pending(state).length) break;
  }
  return i;
}

export function gradeDue(state) {
  let n = 0;
  for (const s of state.signals) {
    if (s.status !== 'open') continue;
    const r = gradeSignal(s, replay.closesAfter(state.sim, s.symbol, s.issuedOn), replay.closesAfter(state.sim, s.benchmark, s.issuedOn));
    if (!r) continue;
    s.status = 'graded'; s.result = r; n++;
  }
  if (n) log(state, 'system', `Graded ${n} call${n > 1 ? 's' : ''} that reached their horizon.`);
  return n;
}

// ---------- formatting shared by screens

export const usd = (v, d = 0) => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (v, d = 2) => (v > 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
export const fmtQty = o => String(+(+o.qty).toFixed(CRYPTO.includes(o.symbol) ? 5 : 3));
