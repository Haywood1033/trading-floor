// Mirrors the mockup's sample portfolio (about $24.3k equity).
export function samplePortfolio() {
  const positions = {
    AAPL: { qty: 8, price: 228.40, sector: 'Tech', assetClass: 'stock' },
    MSFT: { qty: 4, price: 431.10, sector: 'Tech', assetClass: 'stock' },
    INTC: { qty: 95, price: 22.10, sector: 'Tech', assetClass: 'stock' },
    F: { qty: 220, price: 10.85, sector: 'Auto', assetClass: 'stock' },
    T: { qty: 120, price: 21.60, sector: 'Telecom', assetClass: 'stock' },
    DIS: { qty: 18, price: 96.30, sector: 'Media', assetClass: 'stock' },
    PFE: { qty: 90, price: 26.40, sector: 'Health', assetClass: 'stock' },
    BTC: { qty: 0.035, price: 63800, sector: 'Crypto', assetClass: 'crypto' },
    ETH: { qty: 0.6, price: 2540, sector: 'Crypto', assetClass: 'crypto' },
    SOL: { qty: 4, price: 148, sector: 'Crypto', assetClass: 'crypto' }
  };
  const snapshot = { cash: 4700, positions, startOfDayEquity: 0 };
  let eq = snapshot.cash;
  for (const p of Object.values(positions)) eq += p.qty * p.price;
  snapshot.startOfDayEquity = eq;
  return snapshot;
}

export const buy = (symbol, qty, price, extra = {}) => ({ symbol, side: 'buy', qty, price, sector: 'Tech', assetClass: 'stock', ...extra });
export const sell = (symbol, qty, price, extra = {}) => ({ symbol, side: 'sell', qty, price, ...extra });
