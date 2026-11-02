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

// Wilder's RSI over the last `lookback` bars (enough for the smoothing to settle).
export function rsi(closes, n = 2, lookback = 100) {
  if (!closes || closes.length < n + 1) return null;
  const c = closes.slice(-Math.min(closes.length, lookback + n + 1));
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}
