// Starting hard limits. Fractions are of total account equity.
export const DEFAULT_LIMITS = Object.freeze({
  maxPositionPct: 0.10,          // any single stock, after the order fills
  maxCryptoPct: 0.20,            // all crypto combined
  sectorLimits: { Tech: 0.40 },  // per-sector caps; sectors not listed are uncapped
  minCashPct: 0.05,              // cash floor after a buy
  dailyLossLimitPct: -0.02,      // new buys blocked once the day is down this much
  maxOrderValue: 5000,           // no single order larger than this, approved or not
  // Day-trade cap for small margin accounts. Set dayTradeLimit to null if your
  // broker or the current rules don't apply one to your account.
  dayTradeLimit: 3,
  dayTradeEquityThreshold: 25000,
  // Auto mode: only orders that pass every check above AND these.
  autoMaxOrderValue: 1500,
  autoTiers: ['elite', 'allstar', 'value']
});
