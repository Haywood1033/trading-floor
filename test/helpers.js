// Shared test data (not a test file: no test() calls).

export function synthHist(n = 400, syms = { SPY: 0.0004, XLK: 0.0008, TLT: -0.0001 }, lateStart = {}) {
  const dates = []; let d = Date.UTC(2018, 0, 2);
  while (dates.length < n) { const x = new Date(d); if (x.getUTCDay() % 6) dates.push(x.toISOString().slice(0, 10)); d += 864e5; }
  const closes = {};
  for (const [s, mu] of Object.entries(syms)) { let c = 100; closes[s] = dates.map((_, i) => { c *= 1 + mu + Math.sin(i * 1.7 + s.length) * 0.01; return i < (lateStart[s] || 0) ? null : +c.toFixed(4); }); }
  return { dates, closes };
}
