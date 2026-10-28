// Quants desk: each quant's rules, today's view, capital cap, mode and full call history.

import * as D from '../desk.js';
import { reviewPortfolio } from '../../src/quants/portfolioReviewer.js';
import { runMomentum, DEFAULT_UNIVERSE } from '../../src/quants/momentum.js';
import { esc, cls, p1, panel, seg, tierChip } from '../ui.js';
import { metaFor } from '../../src/data/universe.js';
const metaName = sym => metaFor(sym)?.name || '';

const RULES = {
  rev: [
    'Looks only at what the fund holds. Scores each holding 0–6 against SPY (stocks) or BTC (other coins).',
    'Trails the benchmark by >10% over 6 months: 2 points; by 5–10%: 1. Down over 6 months: 1. Below 200-day average: 1. 50-day under 200-day: 1. More than 20% off 52-week high: 1.',
    '5+ proposes selling the whole position; 3–4 is a watch. Any stock over the position limit gets a trim proposal.',
    'Backtest note: on today\'s large caps (2017–2026) its sells were right 44% of the time. Survivorship bias works against it there, so the result is inconclusive.'
  ],
  mom: [
    'Ranks a 19-name universe on 12-month return skipping the latest month ("12-1").',
    'A name must be above its 200-day average and up at least 10%.',
    'Proposes buying the top 5, each sized to about 5% of NAV; tops up positions below that. Exits are left to the reviewer.',
    'Backtest note: on today\'s large caps (2017–2026) its buys beat SPY 60% of the time, about 1.9 points per 3 months better than buying all 19. Survivorship bias flatters this.'
  ]
};
const REPLAY_RULES = bt => {
  const full = bt?.periods?.full?.strategies || [];
  const m = full.find(x => x.id === 'mom3'), spy = full.find(x => x.id === 'spy');
  const pct = v => (v * 100).toFixed(1) + '%';
  return [
    'Ranks the 20 ETFs (US sectors, small caps, international, emerging, bonds, gold, real estate, commodities) on 12-month return skipping the latest month.',
    'Every 21 trading days: holds the top 3 that are above their 200-day average with a positive score, about 31% of the fund each; sells any fund that drops out. Empty slots stay in cash.',
    'This is exactly the strategy in the fair backtest on the Reports desk.',
    m && spy ? `Backtest ${bt.start.slice(0, 4)}–now, after costs: ${pct(m.cagr)} a year vs SPY ${pct(spy.cagr)}; worst drop ${pct(m.maxDrawdown)} vs SPY ${pct(spy.maxDrawdown)}. It has not beaten SPY on return; its case is smaller crashes.` : 'Backtest results load from state/backtest-etf.json.'
  ];
};
const PLANNED = [
  ['Earnings drift', 'Trades the drift after big earnings surprises. Needs an earnings data source (Phase 2).'],
  ['Mean reversion', 'Buys quality names after sharp short-term drops.'],
  ['Crypto trend', 'Holds BTC, ETH, SOL while above trend; cash below it.'],
  ['Covered calls', 'Options income on holdings of 100+ shares (options desk, later).']
];

function todayView(s, q) {
  const snap = D.snapshot(s);
  if (q.id === 'mom' && D.isReplay(s)) {
    const ranked = D.rotationView(s);
    const picks = ranked.slice(0, 3).filter(r => r.ok).map(r => r.symbol);
    const held = Object.entries(s.account.positions).filter(([, p]) => p.openedBy === 'mom').map(([x]) => x);
    const due = D.daysToRebalance(s);
    return `<div class="pad muted" style="font-size:13px">${due ? `Next rebalance in ${due} trading day${due === 1 ? '' : 's'}.` : 'Rebalances at the next open.'} Picks if it rebalanced now: <b>${picks.join(', ') || 'none (all cash)'}</b>.</div>
      <div class="tablewrap"><table><thead><tr><th>#</th><th>Fund</th><th class="r">12-1 return</th><th>Above 200-day</th><th>Status</th></tr></thead><tbody>
      ${ranked.map((r, i) => `<tr><td class="num">${r.score == null ? '-' : i + 1}</td><td><span class="sym">${r.symbol}</span>${held.includes(r.symbol) ? ' <span class="chip crypto">held</span>' : ''}<div class="qdesc">${esc(metaName(r.symbol))}</div></td>
        <td class="r num ${cls(r.score ?? 0)}">${r.score == null ? '-' : D.pct(r.score, 0)}</td><td>${r.above200 == null ? '-' : r.above200 ? 'Yes' : 'No'}</td>
        <td class="${picks.includes(r.symbol) ? 'up' : 'muted'}">${picks.includes(r.symbol) ? 'pick' : esc(r.why)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (q.id === 'mom') {
    const { ranked } = runMomentum(snap, s.sim.history, { universe: DEFAULT_UNIVERSE });
    return `<div class="tablewrap"><table><thead><tr><th>#</th><th>Name</th><th class="r">12-1 return</th><th>Above 200-day</th><th>Status</th></tr></thead><tbody>
      ${ranked.map((r, i) => `<tr><td class="num">${r.score == null ? '-' : i + 1}</td><td class="sym">${r.symbol}</td>
        <td class="r num ${cls(r.score ?? 0)}">${r.score == null ? '-' : D.pct(r.score, 0)}</td><td>${r.above200 == null ? '-' : r.above200 ? 'Yes' : 'No'}</td>
        <td class="${r.eligible ? 'up' : 'muted'}">${esc(r.why)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const { reviews } = reviewPortfolio(snap, s.sim.history);
  if (!reviews.length) return '<div class="empty">The fund holds nothing yet, so there is nothing to review.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>Holding</th><th>Verdict</th><th class="r">Score</th><th>Why</th></tr></thead><tbody>
    ${reviews.map(r => `<tr><td class="sym">${r.symbol}</td><td class="${r.verdict === 'sell' ? 'down' : r.verdict === 'watch' ? 'warn' : 'muted'}">${r.verdict}</td>
      <td class="r num">${r.score ?? '-'}</td><td class="muted">${esc(r.reasons.join('; ') || 'in line or better')}</td></tr>`).join('')}</tbody></table></div>`;
}

function history(s, q) {
  const calls = s.signals.filter(x => x.quantId === q.id).slice(-40).reverse();
  if (!calls.length) return '<div class="empty">No calls yet.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Call</th><th class="r">Entry</th><th>Status</th><th class="r">vs benchmark</th></tr></thead><tbody>
    ${calls.map(c => `<tr><td class="num">${c.issuedOn}</td><td><span class="side ${c.side}" style="font-size:13px">${c.side.toUpperCase()}</span> <span class="sym">${c.symbol}</span></td>
      <td class="r num">${D.usd(c.entryPrice, 2)}</td>
      <td>${c.status === 'open' ? '<span class="muted">open</span>' : c.result.correct ? '<span class="up">right</span>' : '<span class="down">wrong</span>'}</td>
      <td class="r num ${c.result ? cls(c.result.excess) : 'muted'}">${c.result ? D.pct(c.result.excess, 1) : '-'}</td></tr>`).join('')}</tbody></table></div>`;
}

export function renderQuants(s, ui) {
  const board = D.scoreboard(s);
  const eq = D.totals(s).equity;
  const cards = board.map(q => {
    const cap = s.settings.quantAlloc[q.id];
    const used = D.quantExposure(s, q.id);
    const id = 'alloc-' + q.id;
    const capField = q.id === 'rev' ? '<span class="muted">Sells only; no capital cap.</span>'
      : `<div class="field" style="grid-template-columns:minmax(0,1fr) 110px auto"><label for="${id}">Capital cap (% of NAV)</label>
          <input id="${id}" data-draft inputmode="decimal" placeholder="no cap" value="${esc(ui.drafts[id] ?? (cap == null ? '' : String(+(cap * 100).toFixed(1))))}">
          <button class="btn" data-act="saveAlloc" data-q="${q.id}">Save</button>
          <span class="hint">Using ${D.usd(used)} (${p1(used / eq)} of NAV). Buys that would take it over the cap are blocked.</span></div>`;
    return `${panel(q.id === 'mom' && D.isReplay(s) ? 'Momentum rotation' : q.name, '', `<div class="pad" style="display:grid;gap:12px">
        <div class="tiles">
          <div class="tile"><span class="label">Tier</span><span>${tierChip(q.tier)}</span><span class="sub">20 graded calls needed to rate</span></div>
          <div class="tile"><span class="label">Graded</span><span class="value">${q.graded}</span><span class="sub">${q.open} open</span></div>
          <div class="tile"><span class="label">Hit rate</span><span class="value">${q.graded ? p1(q.hitRate) : '-'}</span><span class="sub">${q.graded ? 'lower bound ' + p1(q.lowerBound) : 'no graded calls yet'}</span></div>
          <div class="tile"><span class="label">Avg vs benchmark</span><span class="value ${cls(q.avgExcess)}">${q.graded ? D.pct(q.avgExcess, 1) : '-'}</span><span class="sub">per call, 63 days</span></div>
        </div>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><b>Mode</b>${seg('qmode', q.mode, [['live', 'Live'], ['paper', 'Paper'], ['off', 'Off']], `data-q="${q.id}"`)}
          <span class="muted" style="font-size:12px">Live: proposals go to your queue. Paper: calls are recorded and graded but never queued. Off: not run.</span></div>
        ${capField}
      </div>
      <ul class="rules">${(q.id === 'mom' && D.isReplay(s) ? REPLAY_RULES(ui.backtest) : RULES[q.id]).map(r => `<li>${esc(r)}</li>`).join('')}</ul>`)}
      <div class="cols-2">
        ${panel(q.id === 'mom' ? (D.isReplay(s) ? 'Rotation ranking' : "Today's ranking") : "Today's review", 'from the latest closes', todayView(s, q))}
        ${panel('Call history', 'graded 63 trading days after each call', history(s, q))}
      </div>`;
  }).join('');
  const planned = PLANNED.map(([n, d]) => `<div class="statecard"><b>${n}</b><span>${esc(d)}</span></div>`).join('');
  return `<div class="desk-head"><h1>Quants</h1><p>Each quant proposes; you decide. Its record is built from every call it makes, approved or not, graded against the benchmark.</p></div>
    ${ui.formError ? `<div class="down" role="alert">${esc(ui.formError)}</div>` : ''}
    ${cards}
    ${panel('Not built yet', '', planned)}`;
}
