// Brokers don't report sectors, so the sector caps need a lookup. Unknown symbols fall
// into 'Unknown', which has no cap; add symbols here as the portfolio grows.
const SECTORS = {
  Tech: ['AAPL', 'MSFT', 'NVDA', 'INTC', 'AMD', 'GOOGL', 'GOOG', 'META', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'CSCO', 'QCOM', 'TXN', 'IBM', 'XLK', 'QQQ'],
  Auto: ['TSLA', 'F', 'GM', 'RIVN'],
  Telecom: ['T', 'VZ', 'TMUS'],
  Media: ['DIS', 'NFLX', 'CMCSA', 'WBD'],
  Health: ['PFE', 'JNJ', 'MRK', 'ABBV', 'LLY', 'UNH', 'XLV'],
  Energy: ['XOM', 'CVX', 'COP', 'XLE'],
  Financials: ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'XLF'],
  Retail: ['AMZN', 'WMT', 'COST', 'TGT', 'HD']
};
const LOOKUP = Object.fromEntries(Object.entries(SECTORS).flatMap(([s, syms]) => syms.map(x => [x, s])));

export function sectorOf(symbol, assetClass = 'stock') {
  if (assetClass === 'crypto') return 'Crypto';
  return LOOKUP[symbol] || 'Unknown';
}
