// The ETF universe for the fair backtest and the replay. Every fund here traded continuously
// since at least early 2006, so a backtest from 2007 has no survivorship bias from the list
// itself: these were chosen for what they cover, not for how they did.

export const ETF_UNIVERSE = [
  { symbol: 'SPY', name: 'S&P 500', sector: 'US equity', group: 'equity' },
  { symbol: 'QQQ', name: 'Nasdaq 100', sector: 'Tech', group: 'equity' },
  { symbol: 'IWM', name: 'US small caps', sector: 'US equity', group: 'equity' },
  { symbol: 'EFA', name: 'Developed markets ex-US', sector: 'International', group: 'equity' },
  { symbol: 'EEM', name: 'Emerging markets', sector: 'International', group: 'equity' },
  { symbol: 'XLK', name: 'Technology', sector: 'Tech', group: 'equity' },
  { symbol: 'XLF', name: 'Financials', sector: 'Financials', group: 'equity' },
  { symbol: 'XLE', name: 'Energy', sector: 'Energy', group: 'equity' },
  { symbol: 'XLV', name: 'Health care', sector: 'Health', group: 'equity' },
  { symbol: 'XLY', name: 'Consumer discretionary', sector: 'Retail', group: 'equity' },
  { symbol: 'XLP', name: 'Consumer staples', sector: 'Staples', group: 'equity' },
  { symbol: 'XLI', name: 'Industrials', sector: 'Industrials', group: 'equity' },
  { symbol: 'XLU', name: 'Utilities', sector: 'Utilities', group: 'equity' },
  { symbol: 'XLB', name: 'Materials', sector: 'Materials', group: 'equity' },
  { symbol: 'VNQ', name: 'US real estate', sector: 'Real estate', group: 'real assets' },
  { symbol: 'GLD', name: 'Gold', sector: 'Commodities', group: 'real assets' },
  { symbol: 'DBC', name: 'Commodities basket', sector: 'Commodities', group: 'real assets' },
  { symbol: 'TLT', name: 'Long Treasuries', sector: 'Bonds', group: 'bonds' },
  { symbol: 'IEF', name: '7-10y Treasuries', sector: 'Bonds', group: 'bonds' },
  { symbol: 'LQD', name: 'Corporate bonds', sector: 'Bonds', group: 'bonds' },
  { symbol: 'SHY', name: 'Short Treasuries (cash-like)', sector: 'Cash', group: 'cash' }
];

// Traded in the app by hand; not part of the backtest universe.
export const CRYPTO_REPLAY = [
  { symbol: 'BTC', name: 'Bitcoin', sector: 'Crypto', group: 'crypto' },
  { symbol: 'ETH', name: 'Ethereum', sector: 'Crypto', group: 'crypto' }
];

export const ETF_SYMBOLS = ETF_UNIVERSE.map(e => e.symbol);
export const ROTATION_UNIVERSE = ETF_SYMBOLS.filter(s => s !== 'SHY'); // SHY is where idle cash sits
export const metaFor = sym => [...ETF_UNIVERSE, ...CRYPTO_REPLAY].find(e => e.symbol === sym);
