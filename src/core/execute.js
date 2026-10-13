// The only path from an approved idea to a broker order.
// Kill switch first, then the risk manager, then the broker. Every outcome is logged.

import { evaluateOrder } from '../risk/riskManager.js';
import { record } from './auditLog.js';

// approvedBy: 'user' (approval mode) or 'auto' (caller already ran canAutoExecute).
export async function submitOrder(order, { broker, snapshot, killSwitch, log, ctx = {}, approvedBy }) {
  const halted = killSwitch.isHalted();
  const risk = evaluateOrder(order, snapshot, { ...ctx, halted });

  if (!risk.approved) {
    const failed = risk.checks.filter(c => !c.ok).map(c => c.message);
    record(log, 'veto', { order, failed, approvedBy });
    return { status: 'vetoed', failed };
  }
  if (approvedBy !== 'user' && approvedBy !== 'auto') {
    record(log, 'veto', { order, failed: ['No approval recorded'] });
    return { status: 'vetoed', failed: ['No approval recorded'] };
  }

  try {
    const result = await broker.placeOrder({
      symbol: order.symbol, side: order.side, qty: order.qty, limitPrice: order.price,
      sector: order.sector, assetClass: order.assetClass
    });
    record(log, result.status === 'rejected' ? 'reject' : 'fill', { order, result, approvedBy, broker: broker.name });
    return { status: result.status, result };
  } catch (err) {
    record(log, 'error', { order, error: err.message, broker: broker.name });
    return { status: 'error', error: err.message };
  }
}
