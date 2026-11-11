// The risk manager. Plain deterministic code: same inputs, same answer, every time.
// It never places orders; it only says whether an order may be placed.

import { applyOrder, heldQty, orderValue, summarize } from '../core/portfolio.js';
import { DEFAULT_LIMITS } from './limits.js';

const pct = v => (v * 100).toFixed(1) + '%';

// ctx = { limits?, halted?, dayTradesUsed?, opensDayTrade?, peakEquity? }
// Returns { approved, checks: [{ id, ok, message }] }.
export function evaluateOrder(order, snapshot, ctx = {}) {
  const limits = { ...DEFAULT_LIMITS, ...ctx.limits };
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, ok, message });

  add('halted', !ctx.halted, ctx.halted ? 'Trading is halted (kill switch)' : 'Trading active');

  const valid = order && ['buy', 'sell'].includes(order.side) && order.qty > 0 && order.price > 0 && !!order.symbol;
  add('valid', valid, valid ? 'Order is well formed' : 'Order needs a symbol, side, positive qty and positive price');
  if (!valid) return finish(checks);

  // Size cap: buys only, so a position can always be closed.
  if (order.side === 'buy') {
    const value = orderValue(order), cap = orderCap(limits, snapshot);
    add('maxOrderValue', value <= cap + 1e-9, `Order $${value.toFixed(0)}; max $${cap.toFixed(0)}`);
  }

  if (order.side === 'sell') {
    const held = heldQty(snapshot, order.symbol);
    add('noShort', order.qty <= held + 1e-9, `Selling ${order.qty} of ${held} held`);
  }

  if (limits.dayTradeLimit != null && ctx.opensDayTrade) {
    const equity = summarize(snapshot).equity;
    const applies = equity < limits.dayTradeEquityThreshold;
    const used = ctx.dayTradesUsed || 0;
    add('dayTrades', !applies || used < limits.dayTradeLimit,
      applies ? `Day trades ${used} / ${limits.dayTradeLimit} (5-day)` : 'Day-trade cap does not apply at this equity');
  }

  if (order.side === 'buy') {
    const before = summarize(snapshot);
    const after = summarize(applyOrder(snapshot, order));
    const assetClass = snapshot.positions[order.symbol]?.assetClass || order.assetClass;
    const sector = snapshot.positions[order.symbol]?.sector || order.sector;

    const dayPct = before.equity / snapshot.startOfDayEquity - 1;
    add('dailyLoss', dayPct > limits.dailyLossLimitPct,
      `Day ${pct(dayPct)}; buys stop at ${pct(limits.dailyLossLimitPct)}`);

    // The drawdown breaker: once the desk trips it, buys pause until it re-arms. Callers
    // without a breaker (ctx.breaker undefined) get the plain drawdown test.
    if (ctx.breaker) add('drawdown', false, `Drawdown breaker tripped; buys paused until ${ctx.breaker.untilDate || 'it re-arms'}`);
    else if (ctx.breaker === undefined && limits.maxDrawdownPct != null && ctx.peakEquity > 0) {
      const dd = before.equity / ctx.peakEquity - 1;
      add('drawdown', dd > -limits.maxDrawdownPct, `Drawdown ${pct(dd)}; buys stop at -${pct(limits.maxDrawdownPct)}`);
    }

    add('cashFloor', after.cash >= limits.minCashPct * after.equity,
      `Cash after ${pct(after.cash / after.equity)} / min ${pct(limits.minCashPct)}`);

    if (assetClass === 'crypto') {
      const c = after.crypto / after.equity;
      add('cryptoExposure', c <= limits.maxCryptoPct, `Crypto ${pct(c)} / ${pct(limits.maxCryptoPct)}`);
    } else {
      const p = after.bySymbol[order.symbol] / after.equity;
      const cap = assetClass === 'etf' ? (limits.maxEtfPct ?? limits.maxPositionPct) : limits.maxPositionPct;
      add('positionSize', p <= cap, `${order.symbol} ${pct(p)} / ${pct(cap)}`);
    }

    const sectorCap = limits.sectorLimits?.[sector];
    if (sectorCap != null) {
      const s = after.bySector[sector] / after.equity;
      add('sectorExposure', s <= sectorCap, `${sector} ${pct(s)} / ${pct(sectorCap)}`);
    }
  }

  return finish(checks);
}

function finish(checks) {
  return { approved: checks.every(c => c.ok), checks };
}

// Auto mode: the order must pass every hard limit, come from a quant with a proven
// tier, and be small enough. Anything else waits for a human.
export function canAutoExecute(order, snapshot, ctx = {}) {
  const limits = { ...DEFAULT_LIMITS, ...ctx.limits };
  const result = evaluateOrder(order, snapshot, ctx);
  const reasons = result.checks.filter(c => !c.ok).map(c => c.message);
  if (ctx.mode !== 'auto') reasons.push('Approval mode is on');
  if (!limits.autoTiers.includes(ctx.quantTier)) reasons.push(`Quant tier "${ctx.quantTier || 'none'}" is not cleared for auto`);
  const cap = autoCap(limits, snapshot);
  if (order.side === 'buy' && orderValue(order) > cap + 1e-9) reasons.push(`Over the $${cap.toFixed(0)} auto cap`);
  return { auto: reasons.length === 0, reasons };
}

// Dollar caps from the limits: a fixed amount if set, else a share of current NAV.
export function orderCap(limits, snapshot) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  return L.maxOrderValue != null ? L.maxOrderValue : L.maxOrderPct * summarize(snapshot).equity;
}
export function autoCap(limits, snapshot) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  return L.autoMaxOrderValue != null ? L.autoMaxOrderValue : L.autoMaxOrderPct * summarize(snapshot).equity;
}

// Largest quantity (in `step` increments, at or below order.qty) that passes every check.
// Returns 0 if no size fits. Used for the "Resize to fit" button.
export function maxQtyWithinLimits(order, snapshot, ctx = {}, step = 1) {
  // Every check is either independent of size or gets stricter as size grows, so the sizes
  // that pass form a range starting at the smallest: binary search for its top.
  const fits = n => evaluateOrder({ ...order, qty: +(n * step).toFixed(8) }, snapshot, ctx).approved;
  let lo = 0, hi = Math.floor(order.qty / step + 1e-9);
  if (hi > 0 && fits(hi)) return +(hi * step).toFixed(8);
  if (hi < 1 || !fits(1)) return 0;
  lo = 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
  return +(lo * step).toFixed(8);
}
