// Shared test data (not a test file: no test() calls).

const tradingDates = (n, from = Date.UTC(2018, 0, 2)) => {
  const dates = []; let d = from;
  while (dates.length < n) { const x = new Date(d); if (x.getUTCDay() % 6) dates.push(x.toISOString().slice(0, 10)); d += 864e5; }
  return dates;
};

// Smooth, deterministic series: drift plus a sine wiggle. lateStart: { SYM: first index with data }.
export function synthHist(n = 400, syms = { SPY: 0.0004, XLK: 0.0008, TLT: -0.0001 }, lateStart = {}) {
  const dates = tradingDates(n);
  const closes = {};
  for (const [s, mu] of Object.entries(syms)) { let c = 100; closes[s] = dates.map((_, i) => { c *= 1 + mu + Math.sin(i * 1.7 + s.length) * 0.01; return i < (lateStart[s] || 0) ? null : +c.toFixed(4); }); }
  return { dates, closes };
}

// A noisier market whose leaders change over time, for testing the rotation end to end.
// Each symbol's drift flips sign in alternating regimes of `regime` days, with seeded noise.
export function rotatingMarket(n = 1100, { seed = 3, regime = 180 } = {}) {
  const syms = ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'XLK', 'XLE', 'XLV', 'XLU', 'GLD', 'TLT', 'SHY', 'BTC', 'ETH'];
  const dates = tradingDates(n);
  let st = seed >>> 0;
  const rnd = () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st / 2 ** 32 - 0.5; };
  const closes = {};
  syms.forEach((s, k) => {
    let c = 50 + k * 7;
    closes[s] = dates.map((_, i) => {
      const up = (Math.floor(i / regime) + k) % 3 !== 0;
      const mu = s === 'SHY' ? 0.0001 : (up ? 0.0009 : -0.0006) * (1 + (k % 4) * 0.25);
      c *= 1 + mu + rnd() * (s === 'BTC' || s === 'ETH' ? 0.05 : 0.02);
      return +c.toFixed(4);
    });
  });
  return { dates, closes };
}
