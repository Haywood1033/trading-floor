// App controller: loads and saves the fund, runs the simulated clock, routes between desks,
// and turns clicks into desk actions.

import * as D from './desk.js';
import { clockLabel, nextBusinessDay } from './sim.js';
import { renderFloor } from './floor.js';

const KEY = 'tradingFloor.v1';
const $ = id => document.getElementById(id);

const DESKS = [
  { id: 'floor', name: 'Floor', note: 'Overview' },
  { id: 'portfolio', name: 'Portfolio', note: 'Next' },
  { id: 'risk', name: 'Risk', note: 'Planned' },
  { id: 'quants', name: 'Quants', note: 'Planned' },
  { id: 'blotter', name: 'Blotter', note: 'Planned' },
  { id: 'security', name: 'Security', note: 'Planned' },
  { id: 'reports', name: 'Reports', note: 'Planned' }
];
const PLANNED = {
  portfolio: ['Every holding with cost basis, unrealized and realized P&L', 'Allocation by asset, sector and asset class', 'Fund performance vs SPY since inception', 'Position detail: price chart, the calls behind it, its risk numbers'],
  risk: ['Edit every limit: position size, sector caps, crypto, cash floor, daily loss, max drawdown', 'Auto-trade rules: size cap and which quant tiers may trade alone', 'Live exposure and what-if checks', 'History of everything the risk manager blocked, and why'],
  quants: ['One page per quant: rules, today\'s signals, full call history', 'Track record, hit rate, lower bound and tier over time', 'Capital allocation per quant', 'Live, paper or off'],
  blotter: ['Every order: proposed, approved, filled, rejected, expired, cancelled', 'Manual trade ticket for your own ideas, through the same risk checks', 'Fill prices and who approved each trade'],
  security: ['Login', 'Full audit log with search', 'Kill switch history', 'Broker connection status (placeholder until Phase 3)', 'Wash-sale and day-trade tracking', 'Reset and export the fund'],
  reports: ['Daily brief: what the desk saw, proposed and did', 'Performance by quant and for the fund', 'Monthly summary']
};

function startDate() {
  const d = new Date().toISOString().slice(0, 10);
  const wd = new Date(d + 'T12:00:00Z').getUTCDay();
  return wd === 0 || wd === 6 ? nextBusinessDay(d) : d;
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.version === D.STATE_VERSION) return s;
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
  $('nav').innerHTML = DESKS.map(d => `<a href="#${d.id}" ${desk() === d.id ? 'aria-current="page"' : ''}>${d.name}${d.id === 'floor' && n ? `<span class="badge">${n}</span>` : `<small>${d.note}</small>`}</a>`).join('');
}

function renderPlanned(id) {
  const d = DESKS.find(x => x.id === id);
  return `<section class="panel"><div class="pad planned"><span class="pill">${d.note === 'Next' ? 'Building next' : 'Planned for Phase 1'}</span>
    <h1>${d.name} desk</h1><p class="muted">Not built yet. What it will hold:</p>
    <ul>${PLANNED[id].map(x => `<li>${x}</li>`).join('')}</ul></div></section>`;
}

let lastHtml = '';
function render() {
  renderHeader();
  const id = desk();
  const html = id === 'floor' ? renderFloor(state) : renderPlanned(id);
  if (html !== lastHtml) { $('desk').innerHTML = html; lastHtml = html; }
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
    case 'approve': D.approve(state, id); break;
    case 'reject': D.reject(state, id); break;
    case 'fit': D.resizeToFit(state, id); break;
    case 'inc': if (o) D.setQty(state, id, +(o.qty + D.stepFor(o.symbol)).toFixed(6)); break;
    case 'dec': if (o && o.qty - D.stepFor(o.symbol) > 0) D.setQty(state, id, +(o.qty - D.stepFor(o.symbol)).toFixed(6)); break;
    case 'kill': confirmBox('Halt all trading?', 'This cancels every pending order and stops quants from proposing until you resume. Open positions are not sold.', 'Halt trading', () => D.halt(state)); return;
    case 'resume': D.resume(state); break;
    case 'reset': confirmBox('Reset the simulation?', 'This deletes the simulated fund in this browser: positions, orders, call history and the log. It starts again with $100,000 cash.', 'Reset', () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } state = D.freshState({ startDate: startDate() }); D.openDay(state); schedule(); }); return;
    case 'modalOk': $('modal').hidden = true; if (pendingConfirm) pendingConfirm(); pendingConfirm = null; break;
    case 'modalCancel': $('modal').hidden = true; pendingConfirm = null; return;
    default: return;
  }
  save(true); render();
}
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
window.addEventListener('hashchange', () => { lastHtml = ''; render(); $('desk').focus({ preventScroll: true }); });
document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
window.addEventListener('pagehide', () => save(true));

D.openDay(state);
save(true);
render();
schedule();
