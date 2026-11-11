// App controller: loads and saves the fund (server when set up, else this browser), runs the
// daily replay clock, routes between desks, and turns clicks into desk actions.

import * as D from './desk.js';
import { renderFloor } from './floor.js';
import { renderPortfolio } from './desks/portfolio.js';
import { renderRisk, LIMIT_FIELDS, fromInput, SECTORS } from './desks/risk.js';
import { renderQuants } from './desks/quants.js';
import { renderBlotter } from './desks/blotter.js';
import { renderSecurity } from './desks/security.js';
import { renderReports } from './desks/reports.js';
import { TIER_LABEL } from './ui.js';
import { createSync } from './sync.js';
import { loadHistory, earliestStart } from './replay.js';

const KEY = 'tradingFloor.v1';
const BACKUP_KEY = 'tradingFloor.backups';
const MAX_BACKUPS = 3;  // dropped oldest-first whenever the fund itself needs the room
const $ = id => document.getElementById(id);

const DESKS = [
  { id: 'floor', name: 'Floor', render: renderFloor },
  { id: 'portfolio', name: 'Portfolio', render: renderPortfolio },
  { id: 'risk', name: 'Risk', render: renderRisk },
  { id: 'quants', name: 'Quants', render: renderQuants },
  { id: 'blotter', name: 'Blotter', render: renderBlotter },
  { id: 'security', name: 'Security', render: renderSecurity },
  { id: 'reports', name: 'Reports', render: renderReports }
];

// Screen-only state: unsaved form input (drafts), filters, messages. Not saved with the fund.
const ui = { drafts: {}, blotterFilter: 'all', formError: '', ticketMsg: null, sync: null, history: null, backtest: null, marketError: '', backups: [] };
export const DEFAULT_START = '2020-01-02'; // includes the 2020 crash, 2022 bear market and recoveries
// Days per second while playing.
const SPEED = { play: 1.5, fast: 8 };
const readable = s => !!s && (s.version === D.STATE_VERSION || s.version === 3) && !!s.sim && !!s.account;
const sync = createSync({ validate: readable });
ui.sync = sync;

// ---- backups: a fund is never replaced without keeping a copy of the old one in this browser
function readBackups() {
  try { return JSON.parse(localStorage.getItem(BACKUP_KEY)) || []; } catch { return []; }
}
function backup(old, reason) {
  if (!old) return;
  const label = old.sim ? `${D.usd(old.fund?.capital ?? 0)} fund started ${old.fund?.inception ?? '?'}, at ${old.sim.day ?? '?'}` : 'A saved fund this version could not open';
  const list = [{ label, reason, savedAt: Date.now(), state: old }, ...readBackups()].slice(0, MAX_BACKUPS);
  // Drop the oldest until it fits in storage.
  while (list.length) {
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify(list)); break; } catch { list.pop(); }
  }
  ui.backups = list.map(({ state, ...meta }) => meta);
}

function newFund({ start = DEFAULT_START, capital = D.DEFAULT_CAPITAL } = {}) {
  const s = D.freshReplayState({ startDate: start, capital });
  D.decide(s);
  return s;
}
function load() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { /* storage blocked: start fresh */ }
  if (!raw) return newFund();
  try {
    const s = JSON.parse(raw);
    if (readable(s)) return D.migrate(s);
    backup(s, 'Saved by a version of the app this one cannot open');
  } catch {
    backup(raw, 'Could not be read');
  }
  toast('Your saved fund could not be opened, so a new one was started. The old one is kept under Backups on the Security desk.');
  return newFund();
}
let state = null;
let dirty = 0;
// Local copy: always kept, so the app opens instantly and works offline.
function save(force) {
  dirty++;
  if (!force && dirty < 10) return;
  dirty = 0;
  const json = JSON.stringify(state);
  try { localStorage.setItem(KEY, json); return; } catch { /* full: make room below */ }
  // The fund itself comes first: drop backups, oldest first, until it fits.
  const list = readBackups();
  while (list.length) {
    list.pop();
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify(list)); localStorage.setItem(KEY, json); ui.backups = list.map(({ state: _s, ...m }) => m); return; } catch { /* keep dropping */ }
  }
  toast('This browser is out of storage, so the fund could not be saved here.');
}
function replaceFund(next, reason) {
  backup(state, reason);
  state = next;
  save(true);
  lastHtml = '';
}

// ---- server sync
let claim = false;          // set when you press Play here: this device takes the clock
let lastPush = 0, pushTimer = null;
const playing = () => state.settings.speed !== 'pause';
async function pushNow() {
  clearTimeout(pushTimer);
  if (sync.status.mode !== 'synced') return;
  const running = playing() && (claim || sync.holdsClock());
  const r = await sync.save(state, { running });
  if (r.ok) claim = false;
  lastPush = Date.now();
  if (r.conflict) adopt(r.state, 'Your other device saved first, so its copy is shown. This device\'s copy is kept under Backups.', true);
  if (sync.takeQueued()) pushSoon();
  if (sync.status.mode === 'login') showLogin();
  render();
}
function pushSoon() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 300); }
function adopt(next, message, keepOld = false) {
  let migrated;
  try { migrated = D.migrate(next); } catch (e) { toast('A copy from your other device could not be opened: ' + e.message); return; }
  if (keepOld) backup(state, 'Replaced by a newer copy from your other device');
  state = migrated;
  save(true);
  lastHtml = '';
  render({ background: true });
  schedule();
  if (message) toast(message, true);
}
async function pollRemote() {
  if (document.hidden || sync.status.mode !== 'synced') return;
  const r = await sync.poll();
  if (r.state) adopt(r.state);
  else renderHeader();
  if (sync.status.mode === 'login') showLogin();
}

// ---- login
function showLogin(msg = '') {
  clearTimeout(timer);
  $('login').hidden = false; $('loginErr').textContent = msg; $('loginPw').value = ''; $('loginPw').focus();
}
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginErr').textContent = 'Checking…';
  const r = await sync.login($('loginPw').value);
  if (!r.ok) { $('loginErr').textContent = r.reason; return; }
  $('login').hidden = true;
  await connect();
});

function desk() {
  const id = location.hash.replace('#', '');
  return DESKS.some(d => d.id === id) ? id : 'floor';
}

const SYNC_TEXT = { checking: 'Connecting…', local: 'This browser only', login: 'Signed out', error: 'Sync problem' };
function syncText() {
  if (sync.status.mode !== 'synced') return SYNC_TEXT[sync.status.mode] || '';
  return sync.otherRunning() && !claim ? 'Synced · playing on your other device' : 'Synced';
}
let lastNav = '';
function renderHeader() {
  $('syncBadge').textContent = syncText();
  $('syncBadge').className = 'syncbadge ' + sync.status.mode;
  $('syncNote').textContent = sync.status.mode === 'synced' ? 'Saved on the server and shared by your devices.' : 'Saved in this browser only.';
  $('mktDot').className = 'dot' + (playing() && !state.sim.ended ? '' : ' off');
  $('mktState').textContent = state.sim.ended ? 'Caught up' : playing() ? 'Playing' : 'Paused';
  $('simDate').textContent = new Date(state.sim.day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) + ' close';
  $('marketKind').textContent = state.sim.ended ? 'Replay caught up to the latest data' : 'Real history';
  for (const b of $('speedSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.settings.speed));
  for (const b of $('modeSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.settings.mode));
  $('haltBar').hidden = !state.kill.halted;
  $('haltTime').textContent = state.kill.at || '';
  $('killBtn').disabled = state.kill.halted;
  const n = D.pending(state).length;
  const nav = DESKS.map(d => `<a href="#${d.id}" ${desk() === d.id ? 'aria-current="page"' : ''}>${d.name}${d.id === 'floor' && n ? `<span class="badge">${n}</span>` : ''}</a>`).join('');
  if (nav !== lastNav) { $('nav').innerHTML = nav; lastNav = nav; }
}

// ---- rendering: only the parts of the desk that changed are replaced, so a button you are
// pressing or a field you are using is left alone unless its own panel changed.
let lastHtml = '';
const sameAttrs = (a, b) => a.attributes.length === b.attributes.length && [...a.attributes].every(x => b.getAttribute(x.name) === x.value);
function patch(parent, next, depth = 0) {
  const a = [...parent.childNodes], b = [...next.childNodes];
  const structural = a.length !== b.length || a.some((n, i) => n.nodeName !== b[i].nodeName);
  if (structural || depth > 3) { parent.replaceChildren(...b); return; }
  a.forEach((n, i) => {
    const m = b[i];
    if (n.nodeType !== 1) { if (n.nodeValue !== m.nodeValue) n.nodeValue = m.nodeValue; return; }
    if (n.outerHTML === m.outerHTML) return;
    if (sameAttrs(n, m) && n.childNodes.length && depth < 3) patch(n, m, depth + 1);
    else n.replaceWith(m);
  });
}
// A field on the desk is in use (an open dropdown, or a text box being typed in).
const editing = () => {
  const a = document.activeElement;
  return !!a && $('desk').contains(a) && /^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName);
};
let pressing = false, held = false;
// background: a redraw from the clock or another device, not from something you did. Those
// wait while you are using a field or pressing a button.
function render({ background = false } = {}) {
  renderHeader();
  if (background && (editing() || pressing)) { held = true; return; }
  held = false;
  const d = DESKS.find(x => x.id === desk());
  const html = d.render(state, ui);
  if (html === lastHtml) return;
  const a = document.activeElement;
  const focusId = a && a.id && $('desk').contains(a) ? a.id : null;
  const caret = focusId && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  if (lastHtml) patch($('desk'), tpl.content); else $('desk').replaceChildren(tpl.content);
  lastHtml = html;
  if (focusId && $(focusId) && document.activeElement !== $(focusId)) {
    const el = $(focusId);
    el.focus({ preventScroll: true });
    if (caret && el.setSelectionRange) try { el.setSelectionRange(...caret); } catch { /* not a text field */ }
  }
}

// ---- clock: Play steps one trading day at a time and pauses when proposals need you.
let timer = null;
function waitingForYou() {
  return D.pending(state).filter(o => !(state.settings.mode === 'auto' && D.riskFor(state, o).auto.auto)).length;
}
function pause(reason) {
  state.settings.speed = 'pause';
  if (reason) toast(reason, true);
}
function schedule() {
  clearTimeout(timer);
  if (!playing() || sync.status.mode === 'checking' || sync.status.mode === 'login') return;
  if (state.sim.ended) { pause('The replay has caught up to the latest data.'); render(); return; }
  // Another device is playing: follow it (polling brings its changes) and check each second
  // whether it has gone quiet, in which case this device takes over.
  if (!claim && !sync.holdsClock()) { timer = setTimeout(() => { renderHeader(); schedule(); }, 1000); return; }
  timer = setTimeout(() => {
    D.advance(state);
    const n = waitingForYou();
    if (n) pause(`Paused: ${n} proposal${n === 1 ? '' : 's'} waiting for you on the Floor.`);
    save(!!n); render({ background: true });
    if (n || Date.now() - lastPush > 10000) pushNow();
    schedule();
  }, 1000 / SPEED[state.settings.speed]);
}

// ---- actions
let toastTimer = null;
function toast(text, ok = false) {
  const t = $('toast');
  t.textContent = text; t.className = 'toast' + (ok ? '' : ' bad'); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}
const report = (r, okText) => { if (r && !r.ok) toast(`Not done: ${r.reason}`); else if (r && okText) toast(okText, true); };

let pendingConfirm = null;
function confirmBox(title, body, ok, fn) {
  $('modalTitle').textContent = title; $('modalBody').textContent = body; $('modalOk').textContent = ok;
  pendingConfirm = fn; $('modal').hidden = false; $('modalOk').focus();
}
function act(el) {
  const a = el.dataset.act, id = +el.dataset.id, v = el.dataset.v;
  const o = id ? state.orders.find(x => x.id === id) : null;
  switch (a) {
    case 'speed': state.settings.speed = v; claim = v !== 'pause'; schedule(); break;
    case 'logout': sync.logout().then(() => showLogin()); return;
    case 'useLocal': $('login').hidden = true; sync.status.mode = 'local'; schedule(); render(); return;
    case 'skipDays': {
      pause();
      const ran = D.skipDays(state, +v);
      if (state.sim.ended && ran < +v) toast('The replay has caught up to the latest data.', true);
      else if (ran < +v && D.pending(state).length) toast(`Stopped after ${ran} trading day${ran === 1 ? '' : 's'}: proposals are waiting for you.`, true);
      break;
    }
    case 'preset': ui.drafts['nf-date'] = v; break;
    case 'btPeriod': ui.btPeriod = v; break;
    case 'mrPeriod': ui.mrPeriod = v; break;
    case 'newFund': {
      const start = ui.drafts['nf-date'] || DEFAULT_START, cap = Number(ui.drafts['nf-cap'] ?? D.DEFAULT_CAPITAL);
      if (!(cap >= 100 && cap <= 10_000_000)) { ui.formError = 'Starting capital must be between $100 and $10,000,000.'; break; }
      if (start < ui.history.earliest || start > ui.history.latest) { ui.formError = `Pick a start date between ${ui.history.earliest} and ${ui.history.latest}.`; break; }
      ui.formError = '';
      confirmBox('Start a new fund?', `This replaces the current fund with $${cap.toLocaleString('en-US')} cash at the close on ${start}. The current fund is kept under Backups on the Security desk.`, 'Start new fund', () => {
        replaceFund(newFund({ start, capital: cap }), 'Replaced by a new fund');
        claim = true;
        delete ui.drafts['nf-date']; delete ui.drafts['nf-cap']; schedule();
      });
      return;
    }
    case 'restoreBackup': {
      const b = readBackups()[+v];
      if (!b) break;
      if (!readable(b.state)) { toast('This backup was saved by a version of the app this one cannot open. Export it from your browser storage if you need it.'); return; }
      confirmBox('Restore this fund?', `${b.label}. The current fund is kept as a backup.`, 'Restore', () => {
        try { replaceFund(D.migrate(structuredClone(b.state)), 'Replaced by a restored backup'); claim = true; } catch (e) { toast('Could not restore: ' + e.message); }
      });
      return;
    }
    case 'mode': D.setMode(state, v); break;
    case 'qmode': D.setQuantMode(state, el.dataset.q, v); break;
    case 'approve': report(D.approve(state, id)); break;
    case 'reject': D.reject(state, id); break;
    case 'cancel': D.cancelOrder(state, id); break;
    case 'fit': D.resizeToFit(state, id); break;
    case 'inc': if (o) D.setQty(state, id, o.qty + D.nudge(state, o)); break;
    case 'dec': if (o && o.qty - D.nudge(state, o) > 0) D.setQty(state, id, o.qty - D.nudge(state, o)); break;
    case 'rearm': confirmBox('Re-arm the drawdown breaker?', 'Buys are allowed again now, and drawdown is measured from today\'s NAV. This is logged.', 'Re-arm', () => D.rearmBreaker(state)); return;
    case 'kill': confirmBox('Halt all trading?', 'This cancels every waiting and approved order and stops quants from proposing until you resume. Open positions are not sold.', 'Halt trading', () => { D.halt(state); pause(); }); return;
    case 'resume': D.resume(state); break;
    case 'closepos': {
      const sym = el.dataset.sym;
      confirmBox(`Close ${sym}?`, `Sell the whole ${sym} position at the next close. The risk manager checks it again then.`, 'Sell all', () => report(D.closePosition(state, sym), `Selling all ${sym} at the next close.`));
      return;
    }
    case 'bfilter': ui.blotterFilter = v; break;
    case 'submitTicket': {
      const r = D.placeManual(state, { symbol: ui.drafts['t-sym'] || el.closest('.ticket').querySelector('#t-sym').value, side: ui.drafts['t-side'] || 'buy', qty: ui.drafts['t-qty'] });
      ui.ticketMsg = r.ok ? { ok: true, text: 'Approved. It fills at the next close; see it on the Floor.' } : { ok: false, text: r.reason };
      if (r.ok) delete ui.drafts['t-qty'];
      break;
    }
    case 'saveLimits': saveLimits(); break;
    case 'discardLimits': for (const k of Object.keys(ui.drafts)) if (/^(lim|sec|tier)-/.test(k)) delete ui.drafts[k]; ui.formError = ''; break;
    case 'resetLimits': confirmBox('Reset all limits?', 'Every risk limit and auto rule goes back to its default. This is logged.', 'Reset limits', () => { D.resetLimits(state); for (const k of Object.keys(ui.drafts)) if (/^(lim|sec|tier)-/.test(k)) delete ui.drafts[k]; }); return;
    case 'saveSleeve': {
      const q = el.dataset.q, raw = ui.drafts['sleeve-' + q];
      if (raw === undefined) break;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) { ui.formError = 'A sleeve must be a percent from 0 to 100.'; break; }
      const others = D.sleeveTotal(state) - (state.settings.sleeves[q] || 0);
      if (others + n / 100 > 0.95 + 1e-9) { ui.formError = `Sleeves would total ${((others + n / 100) * 100).toFixed(0)}%; keep them at 95% or less so the cash floor holds.`; break; }
      D.setSleeve(state, q, n / 100);
      delete ui.drafts['sleeve-' + q]; ui.formError = '';
      break;
    }
    case 'export': exportFund(); return;
    case 'reset': location.hash = '#security'; return;
    case 'retry': location.reload(); return;
    case 'modalOk': $('modal').hidden = true; if (pendingConfirm) pendingConfirm(); pendingConfirm = null; break;
    case 'modalCancel': $('modal').hidden = true; pendingConfirm = null; return;
    default: return;
  }
  save(true); pushSoon(); render();
}
function saveLimits() {
  const L = state.settings.limits, d = ui.drafts, changes = {};
  for (const f of LIMIT_FIELDS) {
    const raw = d['lim-' + f.key];
    if (raw === undefined) continue;
    const r = fromInput(f, raw.trim());
    if (r.error) { ui.formError = r.error; return; }
    changes[f.key] = r.value;
  }
  const sectors = { ...L.sectorLimits };
  for (const sec of SECTORS) {
    const raw = d['sec-' + sec];
    if (raw === undefined) continue;
    if (raw.trim() === '') { delete sectors[sec]; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) { ui.formError = `${sec} cap: enter a percent from 0 to 100, or leave blank`; return; }
    sectors[sec] = n / 100;
  }
  changes.sectorLimits = sectors;
  changes.autoTiers = Object.keys(TIER_LABEL).filter(t => (d['tier-' + t] != null ? d['tier-' + t] === 'true' : L.autoTiers.includes(t)));
  ui.formError = '';
  D.updateLimits(state, changes);
  for (const k of Object.keys(d)) if (/^(lim|sec|tier)-/.test(k)) delete d[k];
}

function exportFund() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `trading-floor-${state.sim.day}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Form fields marked data-draft keep their unsaved value across re-renders.
function draft(e) {
  const el = e.target;
  if (!el.matches || !el.matches('[data-draft]')) return;
  ui.drafts[el.id] = el.type === 'checkbox' ? String(el.checked) : el.value;
  if (el.id.startsWith('t-')) ui.ticketMsg = null;
  render();
}

// Buttons act on a completed click or tap, never on touch-down: scrolling a phone screen with
// a finger that starts on Approve must not approve anything. While a finger or mouse button
// is down, background redraws wait, so the button can't be replaced mid-press.
function release() { if (!pressing) return; pressing = false; if (held) setTimeout(() => render({ background: true }), 0); }
function wire() {
  document.addEventListener('input', draft);
  document.addEventListener('change', draft);
  // Leaving a field: catch up on anything that changed while it was in use.
  document.addEventListener('focusout', e => { if ($('desk').contains(e.target)) setTimeout(() => render(), 0); });
  document.addEventListener('pointerdown', () => { pressing = true; });
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  document.addEventListener('click', e => {
    pressing = false;
    const el = e.target.closest('[data-act]');
    if (el && !el.disabled) act(el);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('modal').hidden) { $('modal').hidden = true; pendingConfirm = null; } });
  window.addEventListener('hashchange', () => { ui.formError = ''; ui.ticketMsg = null; lastHtml = ''; render(); $('desk').focus({ preventScroll: true }); window.scrollTo(0, 0); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { save(true); pushNow(); } else pollRemote(); });
  window.addEventListener('pagehide', () => { save(true); pushNow(); });
}

async function loadMarket() {
  const { index, hist } = await loadHistory();
  D.setMarket(hist);
  ui.history = { earliest: earliestStart(hist), latest: hist.dates.at(-1), updated: index.updated };
  try { ui.backtest = await (await fetch('/state/backtest-etf.json', { cache: 'no-cache' })).json(); } catch { /* reports show it as unavailable */ }
}

async function connect() {
  sync.status.mode = 'checking';
  render();
  const r = await sync.connect();
  if (sync.status.mode === 'login') { showLogin(); render(); return; }
  if (r.state) {
    // The server copy wins on open; keep this browser's copy if it was a different fund.
    const differs = state.fund.inception !== r.state.fund?.inception || state.seq !== r.state.seq;
    adopt(r.state, null, differs);
  } else if (r.seed) {
    if (r.foreign) backup(r.foreign, 'Server copy saved by a version of the app this one cannot open');
    claim = playing();
    await pushNow();
  }
  render();
  schedule();
}

async function start() {
  try {
    await loadMarket();
  } catch (e) {
    $('desk').innerHTML = `<div class="loaderr"><h1>Price history did not load</h1>
      <p>The fund replays real market history, so it can't open without it. ${e.message ? `(${e.message.replace(/[<>&]/g, '')})` : ''}</p>
      <p class="muted">Your saved fund is untouched.</p><div><button class="btn primary" data-act="retry">Try again</button></div></div>`;
    document.addEventListener('click', ev => { if (ev.target.closest('[data-act="retry"]')) location.reload(); });
    return;
  }
  ui.backups = readBackups().map(({ state: _s, ...meta }) => meta);
  state = load();
  D.decide(state);
  state.settings.speed = 'pause';        // never resume playing on open
  save(true);
  wire();
  render();
  setInterval(pollRemote, 4000);
  connect();
}
start();
