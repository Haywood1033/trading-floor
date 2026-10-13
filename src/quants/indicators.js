// Small, dependency-free indicators over daily closes (oldest first).

export const last = a => a[a.length - 1];

export function sma(closes, n) {
  if (closes.length < n) return null;
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i];
  return sum / n;
}

// Return over the last n trading days (~21 per month, ~126 per 6 months).
export function ret(closes, n) {
  if (closes.length <= n) return null;
  return last(closes) / closes[closes.length - 1 - n] - 1;
}

export function drawdownFromHigh(closes, n = 252) {
  const window = closes.slice(-n);
  return last(window) / Math.max(...window) - 1;
}
