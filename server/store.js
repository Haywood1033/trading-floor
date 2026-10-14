// The fund's server copy, in Upstash Redis (added from Vercel's Storage tab, which sets the
// env vars below). The server never reads the fund itself: it stores the client's compressed
// state with a revision number and only accepts a write made against the current revision.

const KEY = 'tf:fund';

// Compare-and-set: write only if the stored revision matches.
const CAS = `
local cur = redis.call('HGET', KEYS[1], 'rev') or '0'
if cur ~= ARGV[1] then return {0, cur} end
local nxt = tostring(tonumber(cur) + 1)
redis.call('HSET', KEYS[1], 'rev', nxt, 'state', ARGV[2], 'owner', ARGV[3], 'leaseUntil', ARGV[4], 'savedAt', ARGV[5])
return {1, nxt}`;

export function storeConfig(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export function createStore({ url, token, fetchImpl = globalThis.fetch }) {
  async function cmd(...args) {
    const res = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Storage error (${res.status}): ${body.error || 'unknown'}`);
    return body.result;
  }
  const meta = r => ({ rev: Number(r[0] || 0), owner: r[1] || null, leaseUntil: Number(r[2] || 0), savedAt: Number(r[3] || 0) });
  return {
    async meta() { return meta(await cmd('HMGET', KEY, 'rev', 'owner', 'leaseUntil', 'savedAt')); },
    async get() {
      const r = await cmd('HMGET', KEY, 'rev', 'owner', 'leaseUntil', 'savedAt', 'state');
      return { ...meta(r), state: r[4] || null };
    },
    async put(expectedRev, { state, owner = '', leaseUntil = 0 }, now = Date.now()) {
      const [ok, rev] = await cmd('EVAL', CAS, '1', KEY, String(expectedRev), state, owner, String(leaseUntil), String(now));
      return { ok: ok === 1, rev: Number(rev) };
    }
  };
}
