// Adapter tests against canned Alpaca responses (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlpacaBroker, snapshotFrom } from '../src/brokers/alpaca.js';
import { assertAdapter, ReadOnlyError } from '../src/brokers/adapter.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    const key = `${init.method} ${new URL(url).pathname}`;
    const hit = routes[key];
    if (!hit) return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route ' + key }) };
    const body = typeof hit === 'function' ? hit(url, init) : hit;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls;
  return fn;
}

const ROUTES = {
  'GET /v2/account': { cash: '4700.12', equity: '24310.55', buying_power: '9400.24', last_equity: '24120.00', daytrade_count: 1, trading_blocked: false },
  'GET /v2/positions': [
    { symbol: 'AAPL', qty: '8', current_price: '228.4', asset_class: 'us_equity', cost_basis: '1700', lastday_price: '226.9' },
    { symbol: 'BTCUSD', qty: '0.035', current_price: '63800', asset_class: 'crypto', cost_basis: '2100', lastday_price: '62900' }
  ],
  'GET /v2/stocks/AAPL/quotes/latest': { quote: { bp: 228.3, ap: 228.5, t: '2026-10-13T18:00:00Z' } },
  'GET /v1beta3/crypto/us/latest/quotes': { quotes: { 'BTC/USD': { bp: 63790, ap: 63810, t: '2026-10-13T18:00:00Z' } } },
  'POST /v2/orders': (url, init) => ({ id: 'ord-1', status: 'accepted', filled_qty: '0', filled_avg_price: null })
};
const make = (opts = {}) => createAlpacaBroker({ keyId: 'k', secretKey: 's', fetchImpl: fakeFetch(ROUTES), ...opts });

test('implements the adapter interface and defaults to paper + read-only', () => {
  const b = assertAdapter(make());
  assert.equal(b.name, 'alpaca-paper');
  assert.equal(b.readOnly, true);
});

test('refuses to start without keys', () => {
  assert.throws(() => createAlpacaBroker({ keyId: '', secretKey: '' }), /keys missing/);
});

test('maps account and positions, normalising crypto symbols and sectors', async () => {
  const b = make();
  const a = await b.getAccount();
  assert.equal(a.cash, 4700.12);
  assert.equal(a.lastEquity, 24120);
  const p = await b.getPositions();
  assert.deepEqual(Object.keys(p).sort(), ['AAPL', 'BTC']);
  assert.equal(p.AAPL.sector, 'Tech');
  assert.equal(p.BTC.assetClass, 'crypto');
  assert.equal(p.BTC.sector, 'Crypto');
});

test('snapshot uses previous close equity for the daily loss cap', async () => {
  const snap = await snapshotFrom(make());
  assert.equal(snap.startOfDayEquity, 24120);
  assert.equal(snap.dayTradesUsed, 1);
});

test('quotes stocks and crypto from the right endpoints', async () => {
  const b = make();
  assert.equal((await b.getQuote('AAPL')).last, 228.4);
  assert.equal((await b.getQuote('BTC')).last, 63800);
});

test('read-only adapter refuses orders without calling Alpaca', async () => {
  const fetchImpl = fakeFetch(ROUTES);
  const b = createAlpacaBroker({ keyId: 'k', secretKey: 's', fetchImpl });
  await assert.rejects(b.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, limitPrice: 228 }), ReadOnlyError);
  assert.equal(fetchImpl.calls.length, 0);
});

test('writable adapter sends limit orders with the right time-in-force', async () => {
  const fetchImpl = fakeFetch(ROUTES);
  const b = createAlpacaBroker({ keyId: 'k', secretKey: 's', fetchImpl, readOnly: false });
  await b.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 2, limitPrice: 228.456 });
  await b.placeOrder({ symbol: 'BTC', side: 'sell', qty: 0.01, limitPrice: 63800 });
  const [stock, coin] = fetchImpl.calls.map(c => c.body);
  assert.deepEqual([stock.symbol, stock.type, stock.time_in_force, stock.limit_price], ['AAPL', 'limit', 'day', '228.46']);
  assert.deepEqual([coin.symbol, coin.time_in_force], ['BTC/USD', 'gtc']);
  assert.equal(fetchImpl.calls[0].url.startsWith('https://paper-api.alpaca.markets'), true);
});

test('orders without a limit price are refused', async () => {
  const b = make({ readOnly: false });
  await assert.rejects(b.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1 }), /limitPrice/);
});

test('live mode only when asked for explicitly', () => {
  assert.equal(make({ live: true }).name, 'alpaca-live');
});

test('API errors carry status and message', async () => {
  const b = make();
  await assert.rejects(b.getQuote('ZZZZ'), err => err.status === 404 && /no route/.test(err.message));
});
