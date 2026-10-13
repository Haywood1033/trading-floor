// SAMPLE DATA ONLY. Synthetic daily closes shaped to match the mockup's story
// (INTC, PFE, DIS, F stagnant; AAPL, MSFT steady). Used until a broker is connected.
// Deterministic: same series every run.

import { samplePortfolio as base } from './samplePortfolio.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// 260 trading days. `firstHalf` / `secondHalf` are total returns for each half (~6 months each),
// ending at `end`. `vol` is daily noise.
function series(seed, end, firstHalf, secondHalf, vol = 0.012) {
  const r = rng(seed);
  const n = 260, half = 130;
  const d1 = Math.log(1 + firstHalf) / half, d2 = Math.log(1 + secondHalf) / (n - half);
  const logs = [0];
  for (let i = 1; i < n; i++) logs.push(logs[i - 1] + (i < half ? d1 : d2) + (r() - 0.5) * 2 * vol);
  // Pin the shape so the halves hit their targets exactly despite the noise.
  const fix = (i) => (i <= half ? logs[i] - (logs[half] - half * d1) * (i / half)
                                : logs[i] - (logs[half] - half * d1) - (logs[n - 1] - logs[half] - (n - 1 - half) * d2) * ((i - half) / (n - 1 - half)));
  const fixed = logs.map((_, i) => fix(i));
  const shift = Math.log(end) - fixed[n - 1];
  return fixed.map(v => +Math.exp(v + shift).toFixed(4));
}

export function sampleBars() {
  return {
    SPY: series(1, 575, 0.06, 0.08, 0.008),
    AAPL: series(2, 228.40, 0.05, 0.07),
    MSFT: series(3, 431.10, 0.08, 0.04),
    INTC: series(4, 22.10, -0.05, -0.18, 0.018),
    F: series(5, 10.85, 0.02, -0.09, 0.015),
    T: series(6, 21.60, 0.04, 0.03, 0.009),
    DIS: series(7, 96.30, 0.03, -0.07, 0.013),
    PFE: series(8, 26.40, -0.04, -0.11, 0.011),
    BTC: series(9, 63800, 0.10, 0.09, 0.025),
    ETH: series(10, 2540, 0.05, -0.04, 0.03),
    SOL: series(11, 148, 0.15, 0.12, 0.035),
    // Momentum universe
    NVDA: series(12, 138.40, 0.25, 0.21, 0.022),
    AMZN: series(13, 186, 0.10, 0.08, 0.016),
    GOOGL: series(14, 165, 0.05, 0.12, 0.015),
    META: series(15, 590, 0.20, 0.15, 0.018),
    AVGO: series(16, 172, 0.30, 0.18, 0.022),
    LLY: series(17, 880, 0.15, -0.05, 0.016),
    JPM: series(18, 222, 0.10, 0.09, 0.011),
    XOM: series(19, 118, -0.03, 0.02, 0.012),
    COST: series(20, 890, 0.12, 0.10, 0.010),
    WMT: series(21, 80, 0.15, 0.14, 0.010),
    HD: series(22, 400, 0.02, 0.05, 0.012),
    UNH: series(23, 560, -0.05, -0.08, 0.014),
    TSLA: series(24, 251, -0.10, 0.15, 0.030),
    XLE: series(25, 91.20, -0.02, 0.05, 0.011),
    XLF: series(26, 47, 0.08, 0.08, 0.009),
    XLV: series(27, 150, 0.03, -0.02, 0.008),
    QQQ: series(28, 495, 0.08, 0.09, 0.010)
  };
}

export function samplePortfolio() {
  return base();
}
