// Free daily price history from Yahoo Finance's public chart endpoint. No account or key.
// Unofficial: Yahoo can change or rate-limit it without notice, so callers should expect
// failures and report missing symbols rather than guess.
//
// Returns [{ date: 'YYYY-MM-DD', c: adjustedClose }], oldest first.

const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'DOGE', 'AVAX', 'LTC', 'LINK']);
export const yahooSymbol = s => (CRYPTO.has(s) ? `${s}-USD` : s.replace('.', '-'));

export function parseChart(json) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || 'no chart data');
  const ts = r.timestamp || [];
  const adj = r.indicators?.adjclose?.[0]?.adjclose || r.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (adj[i] == null || !(adj[i] > 0)) continue;
    out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), c: adj[i] });
  }
  return out;
}

// Pass `from` (YYYY-MM-DD) for long histories: with range=max Yahoo silently returns monthly
// bars instead of daily ones.
export async function fetchDaily(symbol, { range = '10y', from = null, fetchImpl = globalThis.fetch, retries = 2 } = {}) {
  const span = from
    ? `period1=${Math.floor(Date.parse(from + 'T00:00:00Z') / 1000)}&period2=${Math.floor(Date.now() / 1000)}`
    : `range=${range}`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?${span}&interval=1d&events=div%2Csplit`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (trading-floor; personal research)' } });
      if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
      return parseChart(await res.json());
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}
