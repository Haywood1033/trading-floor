// Keeps one fund on the server so every device sees the same desk.
//
// - The fund is stored compressed with a revision number; a save made against an old revision
//   is refused, and the device reloads the newer copy instead of overwriting it.
// - Only one device runs the market clock at a time (it holds a 20-second lease it renews when
//   it saves). Other devices show the same fund and follow along; they take over the clock when
//   you press a speed button there, or when the running device goes quiet.
// - If the server isn't set up, everything stays in this browser as before.

const LEASE_MS = 20000;

async function pack(state) {
  const json = JSON.stringify(state);
  if (typeof CompressionStream === 'undefined') return 'j:' + json;
  const buf = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'g:' + btoa(bin);
}
async function unpack(s) {
  if (s.startsWith('j:')) return JSON.parse(s.slice(2));
  const bin = atob(s.slice(2));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

function deviceId() {
  try {
    let id = localStorage.getItem('tradingFloor.device');
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('tradingFloor.device', id); }
    return id;
  } catch { return 'device-' + Math.random().toString(36).slice(2, 8); }
}

export function createSync({ validate }) {
  const me = deviceId();
  const s = { mode: 'checking', rev: 0, owner: null, leaseUntil: 0, saving: false, queued: false, lastError: '', open: false };

  async function api(method, path, body) {
    const r = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    return { status: r.status, data };
  }

  // Returns { state } from the server, { seed: true } when the server is empty,
  // or sets mode to 'local' / 'login' / 'error'.
  async function connect() {
    let r;
    try { r = await api('GET', '/api/fund'); } catch { s.mode = 'local'; s.lastError = 'Server unreachable'; return {}; }
    if (r.status === 503 || r.status === 404) { s.mode = 'local'; s.lastError = r.data?.error || 'not-configured'; return {}; }
    if (r.status === 401) { s.mode = 'login'; return {}; }
    if (r.status !== 200) { s.mode = 'error'; s.lastError = r.data?.detail || r.data?.error || `HTTP ${r.status}`; return {}; }
    Object.assign(s, { mode: 'synced', rev: r.data.rev, owner: r.data.owner, leaseUntil: r.data.leaseUntil, open: !!r.data.open });
    if (!r.data.state) return { seed: true };
    const state = await unpack(r.data.state);
    return validate(state) ? { state } : { seed: true };
  }

  async function login(password) {
    const r = await api('POST', '/api/login', { password });
    return r.status === 200 ? { ok: true } : { ok: false, reason: r.status === 401 ? 'Wrong password.' : r.data?.error || `HTTP ${r.status}` };
  }
  async function logout() { await api('POST', '/api/logout'); s.mode = 'login'; }

  const holdsClock = () => s.mode !== 'synced' || !s.owner || s.owner === me || Date.now() > s.leaseUntil;
  const otherRunning = () => s.mode === 'synced' && s.owner && s.owner !== me && Date.now() <= s.leaseUntil;

  // Saves the fund. running: whether this device is running the clock (renews the lease).
  // Resolves { ok } or { conflict, state } when another device saved first.
  async function save(state, { running }) {
    if (s.mode !== 'synced') return { ok: false };
    if (s.saving) { s.queued = true; return { ok: false, queued: true }; }
    s.saving = true;
    try {
      const leaseUntil = running ? Date.now() + LEASE_MS : 0;
      const owner = running ? me : (s.owner === me ? '' : s.owner || '');
      const r = await api('PUT', '/api/fund', { rev: s.rev, state: await pack(state), owner, leaseUntil: running ? leaseUntil : (s.owner === me ? 0 : s.leaseUntil) });
      if (r.status === 200) { Object.assign(s, { rev: r.data.rev, owner: owner || null, leaseUntil: running ? leaseUntil : s.leaseUntil }); s.lastError = ''; return { ok: true }; }
      if (r.status === 409) {
        const fresh = await api('GET', '/api/fund');
        if (fresh.status === 200 && fresh.data.state) {
          Object.assign(s, { rev: fresh.data.rev, owner: fresh.data.owner, leaseUntil: fresh.data.leaseUntil });
          return { conflict: true, state: await unpack(fresh.data.state) };
        }
      }
      if (r.status === 401) s.mode = 'login';
      s.lastError = r.data?.detail || r.data?.error || `HTTP ${r.status}`;
      return { ok: false };
    } catch (e) {
      s.lastError = 'Could not reach the server';
      return { ok: false };
    } finally {
      s.saving = false;
    }
  }

  // Cheap check for changes from another device. Resolves { state } when there is a newer copy.
  async function poll() {
    if (s.mode !== 'synced' || s.saving) return {};
    try {
      const m = await api('GET', '/api/fund?meta=1');
      if (m.status === 401) { s.mode = 'login'; return {}; }
      if (m.status !== 200) return {};
      s.owner = m.data.owner; s.leaseUntil = m.data.leaseUntil;
      if (m.data.rev === s.rev) return {};
      const full = await api('GET', '/api/fund');
      if (full.status !== 200 || !full.data.state) return {};
      s.rev = full.data.rev; s.owner = full.data.owner; s.leaseUntil = full.data.leaseUntil;
      const state = await unpack(full.data.state);
      return validate(state) ? { state } : {};
    } catch { return {}; }
  }

  function takeQueued() { const q = s.queued; s.queued = false; return q; }

  return { status: s, me, connect, login, logout, save, poll, holdsClock, otherRunning, takeQueued };
}
