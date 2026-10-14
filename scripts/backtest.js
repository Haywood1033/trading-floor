// Fetches ~10 years of daily prices from Yahoo (no key), backtests the quants, and writes
// state/backtest.json. Runs on GitHub Actions; the Claude session can't reach Yahoo.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchDaily } from '../src/data/yahoo.js';
import { runBacktest } from '../src/backtest.js';
import { DEFAULT_UNIVERSE } from '../src/quants/momentum.js';

const symbols = ['SPY', ...DEFAULT_UNIVERSE];
const history = {}, missing = [];
for (const s of symbols) {
  try { history[s] = await fetchDaily(s, { range: '10y' }); }
  catch (e) { missing.push(`${s}: ${e.message}`); }
}
if (!history.SPY?.length) { console.error('No SPY history; cannot backtest.', missing); process.exit(1); }

const result = { generatedAt: new Date().toISOString(), missing, ...runBacktest(history) };
mkdirSync('state', { recursive: true });
writeFileSync('state/backtest.json', JSON.stringify(result, null, 2));

const pct = v => v == null ? '-' : (v * 100).toFixed(1) + '%';
const line = (name, r) => console.log(`${name.padEnd(26)} calls ${String(r.n).padStart(4)}  hit ${pct(r.hitRate).padStart(6)}  lower bound ${pct(r.lowerBound).padStart(6)}  avg vs SPY ${pct(r.avgExcess).padStart(6)}  tier ${r.tier}`);
console.log(`Backtest ${result.period.from} to ${result.period.to}, ${result.rules.universe.length} names`);
line('Momentum (buys)', result.momentum);
line('Baseline: buy everything', result.baselineBuyEverything);
line('Portfolio reviewer (sells)', result.reviewer);
if (missing.length) console.log('Missing:', missing.join('; '));
