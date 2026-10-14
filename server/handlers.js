// Request handlers, kept apart from the Vercel entry files so they can be tested in Node.

import { createStore, storeConfig } from './store.js';
import { checkPassword, isAuthed, sessionCookie, clearCookie } from './auth.js';

const MAX_STATE = 3_000_000; // characters of compressed, base64 state

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

// Both storage and a password are required; without either, the app stays local-only.
function setup(env) {
  const cfg = storeConfig(env);
  if (!cfg) return { error: 'storage-not-configured' };
  if (!env.APP_PASSWORD) return { error: 'password-not-set' };
  return { cfg, password: env.APP_PASSWORD };
}

export async function fundHandler(req, res, { env = process.env, fetchImpl } = {}) {
  const s = setup(env);
  if (s.error) return send(res, 503, { error: s.error });
  if (!isAuthed(req, s.password)) return send(res, 401, { error: 'login-required' });
  const store = createStore({ ...s.cfg, fetchImpl });
  try {
    if (req.method === 'GET') {
      const metaOnly = req.query?.meta === '1' || /[?&]meta=1/.test(req.url || '');
      return send(res, 200, metaOnly ? await store.meta() : await store.get());
    }
    if (req.method === 'PUT') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      if (typeof b.state !== 'string' || !b.state || b.state.length > MAX_STATE) return send(res, 400, { error: 'bad-state' });
      if (!Number.isInteger(b.rev) || b.rev < 0) return send(res, 400, { error: 'bad-rev' });
      const r = await store.put(b.rev, { state: b.state, owner: String(b.owner || '').slice(0, 64), leaseUntil: Number(b.leaseUntil) || 0 });
      if (!r.ok) return send(res, 409, { error: 'conflict', ...(await store.meta()) });
      return send(res, 200, { rev: r.rev });
    }
    res.setHeader('Allow', 'GET, PUT');
    return send(res, 405, { error: 'method-not-allowed' });
  } catch (e) {
    return send(res, 502, { error: 'storage-error', detail: e.message });
  }
}

export async function loginHandler(req, res, { env = process.env } = {}) {
  const s = setup(env);
  if (s.error) return send(res, 503, { error: s.error });
  if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (!checkPassword(b.password, s.password)) {
    await new Promise(r => setTimeout(r, 400)); // slow down guessing
    return send(res, 401, { error: 'wrong-password' });
  }
  return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(s.password) });
}

export async function logoutHandler(req, res) {
  return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
}
