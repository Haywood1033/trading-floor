import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPortfolio } from '../src/quants/portfolioReviewer.js';
import { evaluateOrder } from '../src/risk/riskManager.js';
import { sampleBars, samplePortfolio } from '../src/data/sample.js';
import { sma, ret, drawdownFromHigh } from '../src/quants/indicators.js';

// Straight-line series: start -> end over n days.
const line = (start, end, n = 260) => Array.from({ length: n }, (_, i) => start + (end - start) * i / (n - 1));

function snap(positions, cash = 10000) {
  const s = { cash, positions, startOfDayEquity: 0 };
  s.startOfDayEquity = cash + Object.values(positions).reduce((a, p) => a + p.qty * p.price, 0);
  return s;
}
const stock = (qty, price, extra = {}) => ({ qty, price, sector: 'Tech', assetClass: 'stock', ...extra });

test('indicators', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1, 2], 3), null);
  assert.ok(Math.abs(ret([100, 110, 121], 2) - 0.21) < 1e-12);
  assert.equal(drawdownFromHigh([100, 200, 150]), -0.25);
});

test('a falling stock that lags the market is a sell, with every reason listed', () => {
  const bars = { SPY: line(100, 120), DOG: line(50, 35) };
  const { reviews, proposals } = reviewPortfolio(snap({ DOG: stock(20, 35) }, 50000), bars);
  assert.equal(reviews[0].verdict, 'sell');
  assert.equal(reviews[0].score, 6);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].side, 'sell');
  assert.equal(proposals[0].qty, 20);
  assert.match(proposals[0].thesis, /trails SPY/);
});

test('a stock beating the market is left alone', () => {
  const bars = { SPY: line(100, 110), WIN: line(50, 80) };
  const { reviews, proposals } = reviewPortfolio(snap({ WIN: stock(10, 80) }, 50000), bars);
  assert.equal(reviews[0].verdict, 'ok');
  assert.equal(proposals.length, 0);
});

test('a mild laggard is a watch, not a sell', () => {
  // Up, but trailing SPY by ~8% and slightly below a flat-ish 200-day average.
  const closes = [...line(50, 56, 200), ...line(56, 52, 60)];
  const bars = { SPY: line(100, 112), MEH: closes };
  const { reviews, proposals } = reviewPortfolio(snap({ MEH: stock(10, 52) }, 50000), bars);
  assert.equal(reviews[0].verdict, 'watch');
  assert.equal(proposals.length, 0);
});

test('an oversized healthy position gets a trim back under the limit', () => {
  const bars = { SPY: line(100, 110), BIG: line(50, 80) };
  const s = snap({ BIG: stock(30, 80) }, 10000); // 2400 / 12400 = 19%
  const { proposals } = reviewPortfolio(s, bars);
  assert.equal(proposals.length, 1);
  const after = (30 - proposals[0].qty) * 80 / 12400;
  assert.ok(after < 0.10 && after > 0.08, `after trim ${after}`);
});

test('holdings without enough history are reported, not guessed', () => {
  const { reviews, proposals } = reviewPortfolio(snap({ NEW: stock(5, 10) }), { SPY: line(100, 110), NEW: line(10, 10, 40) });
  assert.equal(reviews[0].verdict, 'no-data');
  assert.equal(proposals.length, 0);
});

test('crypto is compared with BTC and gets no wash-sale note', () => {
  const bars = { SPY: line(100, 110), BTC: line(50000, 70000), ETH: line(3000, 2000) };
  const s = snap({ ETH: { qty: 1, price: 2000, sector: 'Crypto', assetClass: 'crypto', costBasis: 3000 } }, 50000);
  const { proposals } = reviewPortfolio(s, bars);
  assert.match(proposals[0].thesis, /trails BTC/);
  assert.doesNotMatch(proposals[0].thesis, /wash-sale/);
});

test('stock losses mention the wash-sale rule', () => {
  const bars = { SPY: line(100, 120), DOG: line(50, 35) };
  const { proposals } = reviewPortfolio(snap({ DOG: stock(20, 35, { costBasis: 1000 }) }, 50000), bars);
  assert.match(proposals[0].thesis, /\$300 loss \(wash-sale/);
});

test('on the sample portfolio it flags the stagnant names and every proposal passes risk', () => {
  const s = samplePortfolio();
  const { reviews, proposals } = reviewPortfolio(s, sampleBars());
  const sells = reviews.filter(r => r.verdict === 'sell').map(r => r.symbol).sort();
  for (const sym of ['DIS', 'F', 'INTC', 'PFE']) assert.ok(sells.includes(sym), `${sym} should be flagged`);
  for (const sym of ['AAPL', 'BTC']) assert.ok(!sells.includes(sym), `${sym} should not be flagged`);
  for (const p of proposals) assert.equal(evaluateOrder(p, s).approved, true, `${p.symbol} should pass risk`);
});
