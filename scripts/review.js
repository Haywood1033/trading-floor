// Runs the portfolio reviewer and prints its verdicts and proposed orders. Never places orders.
//   npm run review            sample portfolio + sample prices
//   npm run review -- --alpaca  your Alpaca paper account + real daily prices

import { reviewPortfolio, MAX_SCORE } from '../src/quants/portfolioReviewer.js';
import { evaluateOrder } from '../src/risk/riskManager.js';
import { sampleBars, samplePortfolio } from '../src/data/sample.js';

const useAlpaca = process.argv.includes('--alpaca');
let snapshot, bars;

if (useAlpaca) {
  const { createAlpacaBroker, snapshotFrom } = await import('../src/brokers/alpaca.js');
  const broker = createAlpacaBroker({ readOnly: true });
  snapshot = await snapshotFrom(broker);
  const symbols = [...new Set(['SPY', 'BTC', ...Object.keys(snapshot.positions)])];
  bars = {};
  for (const s of symbols) bars[s] = await broker.getBars(s);
  console.log(`Source: ${broker.name} (read-only)\n`);
} else {
  snapshot = samplePortfolio();
  bars = sampleBars();
  console.log('Source: SAMPLE portfolio and SAMPLE prices (not your account)\n');
}

const { reviews, proposals } = reviewPortfolio(snapshot, bars);
const LABEL = { sell: 'SELL ', watch: 'WATCH', ok: 'ok   ', 'no-data': 'n/a  ' };

console.log('Holding  Verdict  Score  Weight  Why');
for (const r of reviews) {
  console.log(`${r.symbol.padEnd(8)} ${LABEL[r.verdict]}    ${r.score == null ? ' -' : String(r.score).padStart(2)}/${MAX_SCORE}  ${(r.weight * 100).toFixed(1).padStart(5)}%  ${r.reasons.join('; ') || 'in line or better'}`);
}

console.log(`\nProposed orders (${proposals.length}), each checked by the risk manager:`);
for (const p of proposals) {
  const risk = evaluateOrder(p, snapshot);
  console.log(`\n  ${p.side.toUpperCase()} ${p.qty} ${p.symbol} @ ~$${p.price.toFixed(2)}  [${risk.approved ? 'passes risk' : 'BLOCKED: ' + risk.checks.filter(c => !c.ok).map(c => c.message).join(', ')}]`);
  console.log(`  ${p.thesis}`);
}
if (!proposals.length) console.log('  None. Nothing looks stale.');
