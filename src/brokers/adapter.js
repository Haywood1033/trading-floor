// Every broker (Alpaca, Robinhood crypto, paper) implements this interface.
// The rest of the system only talks to adapters, so swapping brokers means one new file.
//
//   getAccount()            -> { cash, equity, buyingPower }
//   getPositions()          -> { [symbol]: { qty, price, sector?, assetClass } }
//   getQuote(symbol)        -> { symbol, bid, ask, last, at }
//   placeOrder(order)       -> { id, status: 'filled' | 'accepted' | 'rejected', filledQty, avgPrice, reason? }
//   cancelOrder(id)         -> { id, status }
//   listOpenOrders()        -> [{ id, symbol, side, qty, limitPrice, status }]
//   readOnly                -> true when the adapter must refuse placeOrder

export const ADAPTER_METHODS = ['getAccount', 'getPositions', 'getQuote', 'placeOrder', 'cancelOrder', 'listOpenOrders'];

export function assertAdapter(adapter, name = 'adapter') {
  const missing = ADAPTER_METHODS.filter(m => typeof adapter?.[m] !== 'function');
  if (missing.length) throw new Error(`${name} is missing: ${missing.join(', ')}`);
  return adapter;
}

export class ReadOnlyError extends Error {
  constructor(name) {
    super(`${name} is read-only; orders are disabled`);
    this.name = 'ReadOnlyError';
  }
}
