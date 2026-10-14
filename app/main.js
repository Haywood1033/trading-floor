// App controller: loads and saves the fund, runs the simulated clock, routes between desks,
// and turns clicks into desk actions.

import * as D from './desk.js';
import { clockLabel, nextBusinessDay } from './sim.js';
import { renderFloor } from './floor.js';
import { renderPortfolio } from './desks/portfolio.js';
import { renderRisk, LIMIT_FIELDS, fromInput, SECTORS } from './desks/risk.js';
import { renderQuants } from './desks/quants.js';
import { renderBlotter } from './desks/blotter.js';
import { renderSecurity } from './desks/security.js';
import { renderReports } from './desks/reports.js';
import { TIER_LABEL } from './ui.js';

const KEY = 'tradingFloor.v1';
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

// Screen-only state: unsaved form input (drafts), filters, messages. Not saved.
const ui = { drafts: {}, blotterFilter: 'all', formError: '', ticketMsg: null };

function startDate() {
  const d = new Date().toISOString().slice(0, 10);
  const wd = new Date(d + 'T12:00:00Z').getUTCDay();
  return wd === 0 || wd === 6 ? nextBusinessDay(d) : d;
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.version === D.STATE_VERSION) return D.migrate(s);
  } catch { /* fall through to a fresh fund */ }
  return D.freshState({ startDate: startDate() });
}
let state = load();
let dirty = 0;
function save(force) {
  dirty++;
  if (!force && dirty < 10) return;
  dirty = 0;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full or blocked: keep running */ }
}

function desk() {
  const id = location.hash.replace('#', '');
  return DESKS.some(d => d.id === id) ? id : 'floor';
}

function renderHeader() {
  const open = D.marketOpen(state);
  $('mktDot').className = 'dot' + (open && state.settings.speed ? '' : ' off');
  $('mktState').textContent = !open ? 'Closed' : state.settings.speed ? 'Market open' : 'Paused';
  $('simDate').textContent = new Date(state.sim.day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  $('clock').textContent = clockLabel(state.sim);
  for (const b of $('speedSeg').children) b.setAttribute('aria-pressed', String(+b.dataset.v === state.settings.speed));
  for (const b of $('modeSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.settings.mode));
  $('haltBar').hidden = !state.kill.halted;
  $('haltTime').textContent = state.kill.at || '';
  $('killBtn').disabled = state.kill.halted;
  const n = D.pending(state).length;
  $('nav').innerHTML = DESKS.map(d => `<a href="#${d.id}" ${desk() === d.id ? 'aria-current="page"' : ''}>${d.name}${d.id === 'floor' && n ? `<span class="badge">${n}</span>` : ''}</a>`).join('');
}

let lastHtml = '';
function render() {
  renderHeader();
  const d = DESKS.find(x => x.id === desk());
  const html = d.render(state, ui);
  if (html === lastHtml) return;
  // Keep focus and caret in the field being edited while prices tick.
  const a = document.activeElement;
  const focusId = a && a.id && $('desk').contains(a) ? a.id : null;
  const caret = focusId && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
  $('desk').innerHTML = html;
  lastHtml = html;
  if (focusId && $(focusId)) {
    const el = $(focusId);
    el.focus({ preventScroll: true });
    if (caret && el.setSelectionRange) try { el.setSelectionRange(...caret); } catch { /* not a text field */ }
  }
}

// ---- clock
let timer = null;
function schedule() {
  clearTimeout(timer);
  const speed = state.settings.speed;
  if (!speed) return;
  timer = setTimeout(() => { D.tick(state); save(); render(); schedule(); }, 1000 / speed);
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
    case 'speed': state.settings.speed = +v; schedule(); break;
    case 'skip': D.skipToClose(state); break;
    case 'mode': D.setMode(state, v); break;
    case 'qmode': D.setQuantMode(state, el.dataset.q, v); break;
    case 'approve': report(D.approve(state, id)); break;
    case 'reject': D.reject(state, id); break;
    case 'fit': D.resizeToFit(state, id); break;
    case 'inc': if (o) D.setQty(state, id, +(o.qty + D.stepFor(o.symbol)).toFixed(6)); break;
    case 'dec': if (o && o.qty - D.stepFor(o.symbol) > 0) D.setQty(state, id, +(o.qty - D.stepFor(o.symbol)).toFixed(6)); break;
    case 'kill': confirmBox('Halt all trading?', 'This cancels every pending order and stops quants from proposing until you resume. Open positions are not sold.', 'Halt trading', () => D.halt(state)); return;
    case 'resume': D.resume(state); break;
    case 'closepos': {
      const sym = el.dataset.sym;
      confirmBox(`Close ${sym}?`, `Sell the whole ${sym} position at the current price. The risk manager still checks it.`, 'Sell all', () => report(D.closePosition(state, sym), `Sold all ${sym}.`));
      return;
    }
    case 'bfilter': ui.blotterFilter = v; break;
    case 'submitTicket': {
      const r = D.placeManual(state, { symbol: ui.drafts['t-sym'] || el.closest('.ticket').querySelector('#t-sym').value, side: ui.drafts['t-side'] || 'buy', qty: ui.drafts['t-qty'] });
      ui.ticketMsg = r.ok ? { ok: true, text: 'Filled. See it at the top of the orders list.' } : { ok: false, text: r.reason };
      if (r.ok) delete ui.drafts['t-qty'];
      break;
    }
    case 'saveLimits': saveLimits(); break;
    case 'discardLimits': for (const k of Object.keys(ui.drafts)) if (/^(lim|sec|tier)-/.test(k)) delete ui.drafts[k]; ui.formError = ''; break;
    case 'resetLimits': confirmBox('Reset all limits?', 'Every risk limit and auto rule goes back to its default. This is logged.', 'Reset limits', () => { D.resetLimits(state); for (const k of Object.keys(ui.drafts)) if (/^(lim|sec|tier)-/.test(k)) delete ui.drafts[k]; }); return;
    case 'saveAlloc': {
      const q = el.dataset.q, raw = ui.drafts['alloc-' + q];
      if (raw === undefined) break;
      if (raw.trim() === '') D.setQuantAlloc(state, q, null);
      else { const n = Number(raw); if (!Number.isFinite(n) || n < 0 || n > 100) { ui.formError = 'Capital cap must be a percent from 0 to 100, or blank for no cap.'; break; } D.setQuantAlloc(state, q, n / 100); }
      delete ui.drafts['alloc-' + q]; ui.formError = '';
      break;
    }
    case 'export': exportFund(); return;
    case 'reset': confirmBox('Reset the simulation?', 'This deletes the simulated fund in this browser: positions, orders, call history and the log. It starts again with $100,000 cash.', 'Reset', () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } state = D.freshState({ startDate: startDate() }); D.openDay(state); schedule(); }); return;
    case 'modalOk': $('modal').hidden = true; if (pendingConfirm) pendingConfirm(); pendingConfirm = null; break;
    case 'modalCancel': $('modal').hidden = true; pendingConfirm = null; return;
    default: return;
  }
  save(true); render();
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
  const tiers = Object.keys(TIER_LABEL).filter(t => (d['tier-' + t] != null ? d['tier-' + t] === 'true' : L.autoTiers.includes(t)));
  changes.autoTiers = tiers;
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
document.addEventListener('input', draft);
document.addEventListener('change', draft);

// Act on pointerdown so a re-render between press and release can't swallow the click;
// keyboard activation still arrives as a click with detail 0.
document.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) { e.preventDefault(); act(el); }
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled && e.detail === 0) act(el);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('modal').hidden) { $('modal').hidden = true; pendingConfirm = null; } });
window.addEventListener('hashchange', () => { ui.formError = ''; ui.ticketMsg = null; lastHtml = ''; render(); $('desk').focus({ preventScroll: true }); window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
window.addEventListener('pagehide', () => save(true));

D.openDay(state);
save(true);
render();
schedule();
