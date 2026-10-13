// Portfolio snapshots are plain objects so every risk check can be a pure function.
//
// snapshot = {
//   cash: number,
//   startOfDayEquity: number,
//   positions: { [symbol]: { qty, price, sector, assetClass: 'stock' | 'crypto' } }
// }
//
// order = { symbol, side: 'buy' | 'sell', qty, price, sector, assetClass, quantId? }
// `price` is the expected fill price (limit price, or the latest quote for market orders).

export function orderValue(order) {
  return order.qty * order.price;
}

export function summarize(snapshot) {
  let stocks = 0;
  let crypto = 0;
  const bySector = {};
  const bySymbol = {};
  for (const [symbol, p] of Object.entries(snapshot.positions)) {
    const value = p.qty * p.price;
    bySymbol[symbol] = value;
    bySector[p.sector] = (bySector[p.sector] || 0) + value;
    if (p.assetClass === 'crypto') crypto += value;
    else stocks += value;
  }
  const equity = snapshot.cash + stocks + crypto;
  return { equity, cash: snapshot.cash, stocks, crypto, bySector, bySymbol };
}

// Returns the snapshot as it would look if the order filled at order.price. Does not mutate.
export function applyOrder(snapshot, order) {
  const sign = order.side === 'buy' ? 1 : -1;
  const positions = { ...snapshot.positions };
  const existing = positions[order.symbol];
  const qty = (existing ? existing.qty : 0) + sign * order.qty;
  if (qty <= 1e-9) {
    delete positions[order.symbol];
  } else {
    positions[order.symbol] = {
      qty,
      price: order.price,
      sector: existing ? existing.sector : order.sector,
      assetClass: existing ? existing.assetClass : order.assetClass
    };
  }
  return { ...snapshot, cash: snapshot.cash - sign * orderValue(order), positions };
}

export function heldQty(snapshot, symbol) {
  const p = snapshot.positions[symbol];
  return p ? p.qty : 0;
}
