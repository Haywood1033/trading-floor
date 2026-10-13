// Paper broker: fills instantly at the limit price (or last quote) against an in-memory account.
// Used for tests, the mockup, and paper-mode quants.

import { ReadOnlyError } from './adapter.js';

export function createPaperBroker({ cash = 0, positions = {}, quotes = {}, readOnly = false } = {}) {
  const state = { cash, positions: structuredClone(positions), quotes: { ...quotes }, orders: [], seq: 1 };

  const lastPrice = symbol => {
    const q = state.quotes[symbol];
    if (!q) throw new Error(`No quote for ${symbol}`);
    return q;
  };

  return {
    name: 'paper',
    readOnly,
    setQuote(symbol, price) { state.quotes[symbol] = price; },

    async getAccount() {
      let value = 0;
      for (const [s, p] of Object.entries(state.positions)) value += p.qty * (state.quotes[s] ?? p.price);
      return { cash: state.cash, equity: state.cash + value, buyingPower: state.cash };
    },
    async getPositions() {
      const out = {};
      for (const [s, p] of Object.entries(state.positions)) out[s] = { ...p, price: state.quotes[s] ?? p.price };
      return out;
    },
    async getQuote(symbol) {
      const last = lastPrice(symbol);
      return { symbol, bid: last, ask: last, last, at: new Date().toISOString() };
    },
    async placeOrder(order) {
      if (readOnly) throw new ReadOnlyError('paper');
      const id = 'paper-' + state.seq++;
      const price = order.limitPrice ?? lastPrice(order.symbol);
      const value = order.qty * price;
      const held = state.positions[order.symbol]?.qty || 0;
      let reason = null;
      if (order.side === 'buy' && value > state.cash + 1e-9) reason = 'Insufficient cash';
      if (order.side === 'sell' && order.qty > held + 1e-9) reason = 'Insufficient position';
      if (reason) {
        const rejected = { id, status: 'rejected', filledQty: 0, avgPrice: null, reason };
        state.orders.push({ ...order, ...rejected });
        return rejected;
      }
      const sign = order.side === 'buy' ? 1 : -1;
      const qty = held + sign * order.qty;
      if (qty <= 1e-9) delete state.positions[order.symbol];
      else state.positions[order.symbol] = {
        qty,
        price,
        sector: state.positions[order.symbol]?.sector ?? order.sector,
        assetClass: state.positions[order.symbol]?.assetClass ?? order.assetClass ?? 'stock'
      };
      state.cash -= sign * value;
      const filled = { id, status: 'filled', filledQty: order.qty, avgPrice: price };
      state.orders.push({ ...order, ...filled });
      return filled;
    },
    async cancelOrder(id) { return { id, status: 'not_cancelable' }; },
    async listOpenOrders() { return []; }
  };
}
