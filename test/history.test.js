import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, joinHistory } from '../src/data/history.js';

const rows = (dates, f) => dates.map((d, i) => ({ date: d, close: f(i), div: 0 }));

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

test('format 2: actual closes and dividends, with a total-return series built on join', () => {
  const dates = ['2025-12-30', '2025-12-31', '2026-01-02', '2026-01-05'];
  const series = {
    SPY: dates.map((date, i) => ({ date, close: 100 + i, div: 0 })),
    TLT: dates.map((date, i) => ({ date, close: 90, div: i === 2 ? 0.9 : 0 }))   // flat price, 1% dividend
  };
  const { index, files } = buildHistory(series, s => ({ name: s }));
  assert.equal(index.format, 2);
  assert.deepEqual(files[1].dividends, { TLT: { '2026-01-02': 0.9 } });
  assert.deepEqual(files[1].closes.TLT, [90, 90]);
  const j = joinHistory(files);
  assert.deepEqual(j.divs.TLT, { 2: 0.9 });
  assert.deepEqual(j.closes.TLT, [90, 90, 90, 90]);
  assert.ok(Math.abs(j.tr.TLT[3] / j.tr.TLT[0] - 1.01) < 1e-9, 'total return includes the dividend');
  assert.deepEqual(j.tr.SPY, j.closes.SPY);
});

test('a dividend dated on a non-trading day is credited on the next trading day', () => {
  const dates = ['2026-01-02', '2026-01-05'];
  const { files } = buildHistory({
    SPY: dates.map(date => ({ date, close: 100, div: 0 })),
    X: [{ date: '2026-01-02', close: 10, div: 0 }, { date: '2026-01-04', close: 10, div: 0.1 }, { date: '2026-01-05', close: 10, div: 0 }]
  }, () => ({}));
  assert.deepEqual(files[0].dividends.X, { '2026-01-05': 0.1 });
});

test('format 1 files (adjusted closes, no dividends) still load', () => {
  const j = joinHistory([{ year: 2020, dates: ['2020-01-02'], closes: { SPY: [300] } }]);
  assert.deepEqual(j.tr.SPY, [300]);
  assert.deepEqual(j.divs, {});
});
