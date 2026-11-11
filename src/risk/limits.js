// Starting hard limits. Fractions are of total account equity.
export const DEFAULT_LIMITS = Object.freeze({
  maxPositionPct: 0.10,          // any single stock, after the order fills
  maxEtfPct: 0.35,               // any single ETF (a diversified fund), after the order fills
  maxCryptoPct: 0.20,            // all crypto combined
  sectorLimits: { Tech: 0.40 },  // per-sector caps; sectors not listed are uncapped
  minCashPct: 0.05,              // cash floor after a buy
  dailyLossLimitPct: -0.02,      // new buys blocked once the day is down this much
  maxDrawdownPct: 0.15,          // the breaker trips when NAV falls this far below its peak:
  drawdownCooldownDays: 21,      // buys pause this many trading days, then it re-arms
  maxOrderPct: 0.40,             // no single buy larger than this share of NAV, approved or not
  maxOrderValue: null,           // optional fixed dollar cap instead (null: use maxOrderPct)
  // Day-trade cap for small margin accounts. Set dayTradeLimit to null if your
  // broker or the current rules don't apply one to your account.
  dayTradeLimit: 3,
  dayTradeEquityThreshold: 25000,
  // Auto mode: only orders that pass every check above AND these.
  autoMaxOrderPct: 0.10,         // auto mode: no buy larger than this share of NAV
  autoMaxOrderValue: null,
  autoTiers: ['elite', 'allstar', 'value']
});
