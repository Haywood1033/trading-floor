import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fundHandler, loginHandler, logoutHandler } from '../server/handlers.js';
import { sessionToken, parseCookies } from '../server/auth.js';

// Stand-in for Upstash's REST API: HMGET and the compare-and-set script.
function fakeUpstash() {
  const h = {};
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    const [op, ...a] = JSON.parse(init.body);
    let result;
    if (op === 'HMGET') result = a.slice(1).map(f => h[f] ?? null);
    else if (op === 'EVAL') {
      const [, , , expected, state, owner, lease, at] = a;
      const cur = h.rev ?? '0';
      if (cur !== expected) result = [0, cur];
      else { const nxt = String(Number(cur) + 1); Object.assign(h, { rev: nxt, state, owner, leaseUntil: lease, savedAt: at }); result = [1, nxt]; }
    } else return { ok: false, status: 400, json: async () => ({ error: 'unknown command' }) };
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { fetchImpl, calls, h };
}
const ENV = { KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'tok', APP_PASSWORD: 'correct horse' };
function res() {
  const r = { headers: {}, statusCode: 0, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = b => { r.body = JSON.parse(b); };
  return r;
}
const authed = { cookie: `tf_session=${sessionToken(ENV.APP_PASSWORD)}` };
const call = async (h, req, opts) => { const r = res(); await h(req, r, opts); return r; };

test('without storage or a password the API reports what is missing', async () => {
  assert.equal((await call(fundHandler, { method: 'GET', headers: {} }, { env: {} })).body.error, 'storage-not-configured');
});

test('without APP_PASSWORD the fund syncs with no login, and says it is open', async () => {
  const { fetchImpl } = fakeUpstash();
  const env = { KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'tok' };
  let r = await call(fundHandler, { method: 'GET', url: '/api/fund', headers: {} }, { env, fetchImpl });
  assert.deepEqual([r.statusCode, r.body.open, r.body.rev], [200, true, 0]);
  r = await call(fundHandler, { method: 'PUT', headers: {}, body: { rev: 0, state: 'g:A' } }, { env, fetchImpl });
  assert.equal(r.statusCode, 200);
  r = await call(loginHandler, { method: 'POST', headers: {}, body: {} }, { env });
  assert.deepEqual([r.statusCode, r.body.open], [200, true]);
});

test('with APP_PASSWORD set, responses say the fund is not open', async () => {
  const { fetchImpl } = fakeUpstash();
  const r = await call(fundHandler, { method: 'GET', url: '/api/fund', headers: authed }, { env: ENV, fetchImpl });
  assert.equal(r.body.open, false);
});

test('the fund is locked without a valid session', async () => {
  const { fetchImpl, calls } = fakeUpstash();
  for (const headers of [{}, { cookie: 'tf_session=nope' }]) {
    const r = await call(fundHandler, { method: 'GET', headers }, { env: ENV, fetchImpl });
    assert.equal(r.statusCode, 401);
  }
  assert.equal(calls.length, 0, 'storage is never touched before login');
});

test('login sets a secure session cookie only for the right password', async () => {
  const bad = await call(loginHandler, { method: 'POST', headers: {}, body: { password: 'guess' } }, { env: ENV });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.headers['set-cookie'], undefined);
  const ok = await call(loginHandler, { method: 'POST', headers: {}, body: { password: 'correct horse' } }, { env: ENV });
  assert.equal(ok.statusCode, 200);
  const c = ok.headers['set-cookie'];
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Strict/);
  assert.equal(parseCookies(c.split(';')[0]).tf_session, sessionToken('correct horse'));
  const out = await call(logoutHandler, { method: 'POST', headers: {} });
  assert.match(out.headers['set-cookie'], /Max-Age=0/);
});

test('save and load with revisions; stale writes are refused', async () => {
  const { fetchImpl, calls } = fakeUpstash();
  const opts = { env: ENV, fetchImpl };
  let r = await call(fundHandler, { method: 'GET', url: '/api/fund?meta=1', query: { meta: '1' }, headers: authed }, opts);
  assert.deepEqual([r.statusCode, r.body.rev], [200, 0]);
  r = await call(fundHandler, { method: 'PUT', headers: authed, body: { rev: 0, state: 'g:AAA', owner: 'mac', leaseUntil: 123 } }, opts);
  assert.deepEqual([r.statusCode, r.body.rev], [200, 1]);
  // the phone still thinks rev is 0: refused, told the current revision and owner
  r = await call(fundHandler, { method: 'PUT', headers: authed, body: { rev: 0, state: 'g:BBB', owner: 'phone' } }, opts);
  assert.deepEqual([r.statusCode, r.body.error, r.body.rev, r.body.owner], [409, 'conflict', 1, 'mac']);
  r = await call(fundHandler, { method: 'GET', url: '/api/fund', headers: authed }, opts);
  assert.deepEqual([r.body.rev, r.body.state, r.body.owner, r.body.leaseUntil], [1, 'g:AAA', 'mac', 123]);
  assert.ok(calls.every(c => c.auth === 'Bearer tok' && c.url === 'https://kv.example'));
});

test('rejects malformed saves and other methods', async () => {
  const { fetchImpl } = fakeUpstash();
  const opts = { env: ENV, fetchImpl };
  for (const body of [{ rev: 0 }, { rev: -1, state: 'x' }, { rev: 'a', state: 'x' }, { rev: 0, state: 'x'.repeat(3_000_001) }])
    assert.equal((await call(fundHandler, { method: 'PUT', headers: authed, body }, opts)).statusCode, 400);
  assert.equal((await call(fundHandler, { method: 'DELETE', headers: authed }, opts)).statusCode, 405);
});

test('storage failures surface as 502, not a crash', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  const r = await call(fundHandler, { method: 'GET', url: '/api/fund', headers: authed }, { env: ENV, fetchImpl });
  assert.deepEqual([r.statusCode, r.body.error], [502, 'storage-error']);
});
