// Runs every quant, checks each proposal with the risk manager, and records the calls for
// accuracy tracking. Never places orders.
//   npm run quants              sample portfolio + sample prices  -> data/sample-signals.json
//   npm run quants -- --alpaca  Alpaca paper account + real prices -> data/signals.json

import { reviewPortfolio } from '../src/quants/portfolioReviewer.js';
import { runMomentum, DEFAULT_UNIVERSE } from '../src/quants/momentum.js';
import { evaluateOrder, maxQtyWithinLimits } from '../src/risk/riskManager.js';
import { createTracker, fileSignalStore } from '../src/tracking/tracker.js';
import { sampleBars, samplePortfolio } from '../src/data/sample.js';
import { last } from '../src/quants/indicators.js';

const useAlpaca = process.argv.includes('--alpaca');
let snapshot, bars, source;

if (useAlpaca) {
  const { createAlpacaBroker, snapshotFrom } = await import('../src/brokers/alpaca.js');
  const broker = createAlpacaBroker({ readOnly: true });
  snapshot = await snapshotFrom(broker);
  const symbols = [...new Set(['SPY', 'BTC', ...Object.keys(snapshot.positions), ...DEFAULT_UNIVERSE])];
  bars = {};
  for (const s of symbols) bars[s] = await broker.getBars(s);
  source = `${broker.name} (read-only)`;
} else {
  snapshot = samplePortfolio();
  bars = sampleBars();
  source = 'SAMPLE portfolio and SAMPLE prices (not your account)';
}

const tracker = createTracker(fileSignalStore(useAlpaca ? 'data/signals.json' : 'data/sample-signals.json'));
const NAMES = { rev: 'Portfolio reviewer', mom: 'Momentum' };
const runs = [
  ['rev', reviewPortfolio(snapshot, bars).proposals],
  ['mom', runMomentum(snapshot, bars).proposals]
];

console.log(`Source: ${source}\n`);
for (const [id, proposals] of runs) {
  console.log(`== ${NAMES[id]}: ${proposals.length} proposal${proposals.length === 1 ? '' : 's'}`);
  for (const p of proposals) {
    let risk = evaluateOrder(p, snapshot);
    let note = '';
    if (!risk.approved && p.side === 'buy') {
      const fit = maxQtyWithinLimits(p, snapshot);
      if (fit > 0) { note = ` (resized from ${p.qty} to fit limits)`; p.qty = fit; risk = evaluateOrder(p, snapshot); }
    }
    const status = risk.approved ? 'passes risk' + note : 'BLOCKED: ' + risk.checks.filter(c => !c.ok).map(c => c.message).join(', ');
    const benchmark = p.assetClass === 'crypto' && p.symbol !== 'BTC' ? 'BTC' : 'SPY';
    const { recorded } = tracker.record(p, { benchmark, benchEntry: last(bars[benchmark]) });
    console.log(`  ${p.side.toUpperCase()} ${p.qty} ${p.symbol} @ ~$${p.price.toFixed(2)}  [${status}]${recorded ? '' : '  (already tracking this call)'}`);
    console.log(`    ${p.thesis}`);
  }
  console.log('');
}
console.log('Calls recorded for grading. Run `npm run grade` to see each quant\'s record.');
