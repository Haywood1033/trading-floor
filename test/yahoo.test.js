import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChart, yahooSymbol } from '../src/data/yahoo.js';

test('yahoo symbols and chart parsing', () => {
  assert.equal(yahooSymbol('BTC'), 'BTC-USD');
  assert.equal(yahooSymbol('BRK.B'), 'BRK-B');
  const rows = parseChart({ chart: { result: [{ timestamp: [1704153600, 1704240000, 1704326400],
    indicators: { adjclose: [{ adjclose: [100, null, 102] }] } }] } });
  assert.deepEqual(rows.map(r => [r.date, r.close]), [['2024-01-02', 100], ['2024-01-04', 102]]);
  assert.throws(() => parseChart({ chart: { result: null, error: { description: 'Not Found' } } }), /Not Found/);
});

test('long histories request an explicit date span, not range=max', async () => {
  const { fetchDaily } = await import('../src/data/yahoo.js');
  let url;
  const fetchImpl = async u => { url = u; return { ok: true, json: async () => ({ chart: { result: [{ timestamp: [1704153600], indicators: { adjclose: [{ adjclose: [1] }] } }] } }) }; };
  await fetchDaily('SPY', { from: '2004-01-01', fetchImpl });
  assert.match(url, /period1=1072915200&period2=\d+&interval=1d/);
  assert.doesNotMatch(url, /range=/);
});

test('parsing keeps actual closes, Yahoo\'s adjusted closes and dividends', () => {
  const rows = parseChart({ chart: { result: [{
    timestamp: [1704153600, 1704240000],
    indicators: { quote: [{ close: [95, 96] }], adjclose: [{ adjclose: [93.1, 96] }] },
    events: { dividends: { '1704240000': { amount: 0.3, date: 1704240000 } } }
  }] } });
  assert.deepEqual(rows, [
    { date: '2024-01-02', close: 95, adj: 93.1, div: 0 },
    { date: '2024-01-03', close: 96, adj: 96, div: 0.3 }
  ]);
});
