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

  const value = orderValue(order);
  add('maxOrderValue', value <= limits.maxOrderValue,
    `Order value $${value.toFixed(0)} / $${limits.maxOrderValue}`);

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

    if (limits.maxDrawdownPct != null && ctx.peakEquity > 0) {
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
      add('positionSize', p <= limits.maxPositionPct, `${order.symbol} ${pct(p)} / ${pct(limits.maxPositionPct)}`);
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
  if (orderValue(order) > limits.autoMaxOrderValue) reasons.push(`Over the $${limits.autoMaxOrderValue} auto cap`);
  return { auto: reasons.length === 0, reasons };
}

// Largest quantity (in `step` increments, at or below order.qty) that passes every check.
// Returns 0 if no size fits. Used for the "Resize to fit" button.
export function maxQtyWithinLimits(order, snapshot, ctx = {}, step = 1) {
  const units = Math.floor(order.qty / step + 1e-9);
  for (let n = units; n > 0; n--) {
    const qty = +(n * step).toFixed(8);
    if (evaluateOrder({ ...order, qty }, snapshot, ctx).approved) return qty;
  }
  return 0;
}
