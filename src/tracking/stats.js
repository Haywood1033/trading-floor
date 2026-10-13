// Scoring a quant's graded calls. Same idea as the NFL/HR engines: a hit rate is only
// trusted once its Wilson lower bound clears the bar, so a hot streak on 8 calls can't
// promote a quant.

export function wilsonLower(hits, n, z = 1.645) {
  if (n === 0) return 0;
  const p = hits / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

export const MIN_GRADED = 20;

// elite:    lower bound >= 55%  (clearly better than a coin flip)
// allstar:  lower bound >= 50%
// value:    hit rate >= 52% and beating the benchmark on average, but not yet proven
// unproven: everything else, including fewer than MIN_GRADED graded calls
export function tierFor({ n, hits, avgExcess }) {
  if (n < MIN_GRADED) return 'unproven';
  const lb = wilsonLower(hits, n);
  if (lb >= 0.55) return 'elite';
  if (lb >= 0.50) return 'allstar';
  if (hits / n >= 0.52 && avgExcess > 0) return 'value';
  return 'unproven';
}
