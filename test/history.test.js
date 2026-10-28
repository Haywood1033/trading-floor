import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, joinHistory } from '../src/data/history.js';

const rows = (dates, f) => dates.map((d, i) => ({ date: d, c: f(i) }));

test('history is split by year on SPY trading days and joins back losslessly', () => {
  const dates = ['2024-12-30', '2024-12-31', '2025-01-02', '2025-01-03'];
  const series = {
    SPY: rows(dates, i => 500 + i),
    BTC: rows(['2024-12-29', ...dates], i => 90000 + i),   // trades on a Sunday too
    NEW: rows(dates.slice(2), i => 10 + i)                  // starts later
  };
  const { index, files } = buildHistory(series, s => ({ name: s }));
  assert.deepEqual(index.years, [2024, 2025]);
  assert.equal(index.symbols.NEW.first, '2025-01-02');
  assert.deepEqual(files[0].closes.NEW, [null, null]);
  assert.deepEqual(files[0].closes.BTC, [90001, 90002]);       // Sunday dropped, aligned to SPY days
  const j = joinHistory([files[1], files[0]]);
  assert.deepEqual(j.dates, dates);
  assert.deepEqual(j.closes.SPY, [500, 501, 502, 503]);
  assert.deepEqual(j.closes.NEW, [null, null, 10, 11]);
});
