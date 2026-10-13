// SAMPLE DATA ONLY. The mockup's portfolio (~$24.3k), with made-up cost basis.
export function samplePortfolio() {
  const positions = {
    AAPL: { qty: 8, price: 228.40, sector: 'Tech', assetClass: 'stock', costBasis: 1650 },
    MSFT: { qty: 4, price: 431.10, sector: 'Tech', assetClass: 'stock', costBasis: 1580 },
    INTC: { qty: 95, price: 22.10, sector: 'Tech', assetClass: 'stock', costBasis: 3300 },
    F: { qty: 220, price: 10.85, sector: 'Auto', assetClass: 'stock', costBasis: 2640 },
    T: { qty: 120, price: 21.60, sector: 'Telecom', assetClass: 'stock', costBasis: 2150 },
    DIS: { qty: 18, price: 96.30, sector: 'Media', assetClass: 'stock', costBasis: 1980 },
    PFE: { qty: 110, price: 26.40, sector: 'Health', assetClass: 'stock', costBasis: 3400 },
    BTC: { qty: 0.035, price: 63800, sector: 'Crypto', assetClass: 'crypto', costBasis: 1900 },
    ETH: { qty: 0.6, price: 2540, sector: 'Crypto', assetClass: 'crypto', costBasis: 1750 },
    SOL: { qty: 4, price: 148, sector: 'Crypto', assetClass: 'crypto', costBasis: 520 }
  };
  const snapshot = { cash: 4700, positions, startOfDayEquity: 0, sample: true };
  let eq = snapshot.cash;
  for (const p of Object.values(positions)) eq += p.qty * p.price;
  snapshot.startOfDayEquity = eq;
  return snapshot;
}
