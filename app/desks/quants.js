// Quants desk: each quant's rules, today's view, capital cap, mode and full call history.

import * as D from '../desk.js';
import { reviewPortfolio } from '../../src/quants/portfolioReviewer.js';
import { runMomentum, DEFAULT_UNIVERSE } from '../../src/quants/momentum.js';
import { esc, cls, p1, panel, seg, tierChip } from '../ui.js';
import { metaFor } from '../../src/data/universe.js';
import { mrSignals, RULES as MR } from '../../src/quants/meanReversion.js';
import { cryptoSignals, COINS } from '../../src/quants/cryptoTrend.js';
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
    'Every 21 trading days: holds the top 3 that are above their 200-day average with a positive score, each a third of its sleeve; sells any fund that drops out. Empty slots stay in cash.',
    'This is exactly the strategy in the fair backtest on the Reports desk.',
    m && spy ? `Backtest ${bt.start.slice(0, 4)}–now, after costs: ${pct(m.cagr)} a year vs SPY ${pct(spy.cagr)}; worst drop ${pct(m.maxDrawdown)} vs SPY ${pct(spy.maxDrawdown)}. It has not beaten SPY on return; its case is smaller crashes.` : 'Backtest results load from state/backtest-etf.json.'
  ];
};
const pc = v => (v * 100).toFixed(1) + '%';
const MR_RULES = bt => {
  const f = bt?.meanReversion?.full?.strategies || [];
  const m = f.find(x => x.id === 'mr'), lo = f.find(x => x.id === 'mrlow'), spy = f.find(x => x.id === 'spy');
  return [
    `Buys a fund when it is above its ${MR.trendDays}-day average and its 2-day RSI is under ${MR.entryRsi} (a sharp dip in an uptrend).`,
    `Sells when it closes above its ${MR.exitDays}-day average (the bounce) or after ${MR.maxHoldDays} trading days. At most ${MR.maxPositions} positions, each a third of its sleeve; the most oversold first.`,
    m && spy ? `Backtest ${bt.start.slice(0, 4)}–now: ${pc(m.cagr)} a year after 10 bps costs (${pc(lo.cagr)} at 3 bps) vs SPY ${pc(spy.cagr)}. It wins about 62% of trades but each earns ~0.2% before costs, and it trades ~80 times a year, so costs take nearly all of it. That is why it starts on paper.` : 'Backtest results load from state/backtest-etf.json.'
  ];
};
const CRY_RULES = bt => {
  const c = bt?.crypto?.strategies || [];
  const t = c.find(x => x.id === 'cry'), b = c.find(x => x.id === 'btc');
  return [
    'Holds BTC and ETH, each only while it is above its 200-day average; otherwise that share sits in cash. Checked every 5 trading days.',
    'Each coin gets an equal share of the crypto sleeve. ETH only counts once it has 200 days of history (from late 2018).',
    t && b ? `Backtest ${bt.cryptoStart.slice(0, 4)}–now: ${pc(t.cagr)} a year vs ${pc(b.cagr)} holding BTC; worst year ${pc(t.worstYear.ret)} vs ${pc(b.worstYear.ret)}, worst drop ${pc(t.maxDrawdown)} vs ${pc(b.maxDrawdown)}. A smoother way to hold crypto, not a better return, and still extremely volatile.` : 'Backtest results load from state/backtest-etf.json.',
    'Caution: crypto rose about 300-fold over that window, and was chosen for this desk knowing it. Past crypto returns say little about future ones.'
  ];
};
const PLANNED = [
  ['Earnings drift', 'Trades the drift after big earnings surprises. Needs historical earnings data, which has no free source without an account; and the fund trades ETFs, which have no earnings.'],
  ['Covered calls', 'Options income on holdings of 100+ shares. Needs historical option prices to test, which are not freely available; and a $1,000 fund holds no 100-share positions.']
];
const heldBy = (s, id) => {
  const live = s.settings.quantModes[id] === 'live';
  return live
    ? Object.fromEntries(Object.entries(s.account.positions).filter(([, p]) => (D.ownersOf(p)[id] || 0) > 0).map(([x, p]) => [x, s.daysRun - (p.since?.[id] ?? p.openedRun ?? s.daysRun)]))
    : Object.fromEntries(Object.entries(s.paperBook?.[id] || {}).map(([x, since]) => [x, s.daysRun - since]));
};

function todayView(s, q) {
  const snap = D.snapshot(s);
  if (q.id === 'mr') {
    if (!D.isReplay(s)) return '<div class="empty">Runs on real-history funds only.</div>';
    const held = heldBy(s, 'mr');
    const { scan, exits } = mrSignals(s.sim.history, D.universe(s), held);
    const live = s.settings.quantModes.mr === 'live';
    return `<div class="pad muted" style="font-size:13px">${Object.keys(held).length ? `${live ? 'Holding' : 'Paper book'}: <b>${Object.entries(held).map(([x, d]) => `${x} (${d}d${exits.some(e => e.symbol === x) ? ', exits next open' : ''})`).join(', ')}</b>.` : `${live ? 'Holding' : 'Paper book'}: nothing.`} Checks every open.</div>
      <div class="tablewrap"><table><thead><tr><th>Fund</th><th class="r">RSI(2)</th><th>Above 200-day</th><th>Status</th></tr></thead><tbody>
      ${scan.slice(0, 10).map(r => `<tr><td><span class="sym">${r.symbol}</span>${r.symbol in held ? ' <span class="chip crypto">held</span>' : ''}<div class="qdesc">${esc(metaName(r.symbol))}</div></td>
        <td class="r num ${r.rsi < MR.entryRsi ? 'down' : ''}">${r.rsi == null ? '-' : r.rsi.toFixed(1)}</td><td>${r.uptrend ? 'Yes' : 'No'}</td>
        <td class="${r.signal ? 'up' : 'muted'}">${r.signal ? 'dip: entry signal' : r.uptrend ? 'no dip' : 'downtrend: skipped'}</td></tr>`).join('')}</tbody></table></div>
      <div class="pad muted" style="font-size:12px">The 10 most oversold funds, lowest RSI first.</div>`;
  }
  if (q.id === 'cry') {
    if (!D.isReplay(s)) return '<div class="empty">Runs on real-history funds only.</div>';
    const held = heldBy(s, 'cry');
    const { scan } = cryptoSignals(s.sim.history, COINS);
    const due = Math.max(0, (s.nextCrypto ?? 0) - s.daysRun);
    return `<div class="pad muted" style="font-size:13px">${due ? `Next weekly check in ${due} trading day${due === 1 ? '' : 's'}.` : 'Checks at the next open.'}</div>
      <div class="tablewrap"><table><thead><tr><th>Coin</th><th class="r">Price</th><th class="r">200-day avg</th><th>Trend</th></tr></thead><tbody>
      ${scan.map(r => `<tr><td><span class="sym">${r.symbol}</span>${r.symbol in held ? ' <span class="chip crypto">held</span>' : ''}</td>
        <td class="r num">${r.price == null ? '-' : D.usd(r.price)}</td><td class="r num">${r.average == null ? '-' : D.usd(r.average)}</td>
        <td class="${r.above ? 'up' : r.above === false ? 'down' : 'muted'}">${r.above == null ? 'not enough history yet' : r.above ? 'above: hold' : 'below: cash'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (q.id === 'mom' && D.isReplay(s)) {
    const ranked = D.rotationView(s);
    const picks = ranked.slice(0, 3).filter(r => r.ok).map(r => r.symbol);
    const held = Object.entries(s.account.positions).filter(([, p]) => (D.ownersOf(p).mom || 0) > 0).map(([x]) => x);
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
    const sleeveId = 'sleeve-' + q.id;
    const sv = s.settings.sleeves?.[q.id];
    const capField = q.id === 'rev' ? `<span class="muted">${D.isReplay(s) ? 'Reviews only the positions you opened yourself; sells only.' : 'Sells only; no capital cap.'}</span>`
      : D.isReplay(s) ? `<div class="field" style="grid-template-columns:minmax(0,1fr) 110px auto"><label for="${sleeveId}">Sleeve (% of the fund)</label>
          <input id="${sleeveId}" data-draft inputmode="decimal" value="${esc(ui.drafts[sleeveId] ?? String(+((sv ?? 0) * 100).toFixed(1)))}">
          <button class="btn" data-act="saveSleeve" data-q="${q.id}">Save</button>
          <span class="hint">Sizes its trades from this share of the fund. Using ${D.usd(used)} (${p1(used / eq)}); buys beyond ${p1(cap ?? 0)} are blocked. All sleeves together: ${p1(D.sleeveTotal(s))}.</span></div>`
      : `<div class="field" style="grid-template-columns:minmax(0,1fr) 110px auto"><label for="${id}">Capital cap (% of NAV)</label>
          <input id="${id}" data-draft inputmode="decimal" placeholder="no cap" value="${esc(ui.drafts[id] ?? (cap == null ? '' : String(+(cap * 100).toFixed(1))))}">
          <button class="btn" data-act="saveAlloc" data-q="${q.id}">Save</button>
          <span class="hint">Using ${D.usd(used)} (${p1(used / eq)} of NAV). Buys that would take it over the cap are blocked.</span></div>`;
    return `${panel(q.id === 'mom' && D.isReplay(s) ? 'Momentum rotation' : q.name, '', `<div class="pad" style="display:grid;gap:12px">
        <div class="tiles">
          <div class="tile"><span class="label">Tier</span><span>${tierChip(q.tier)}</span><span class="sub">20 graded calls needed to rate</span></div>
          <div class="tile"><span class="label">Graded</span><span class="value">${q.graded}</span><span class="sub">${q.open} open</span></div>
          <div class="tile"><span class="label">Hit rate</span><span class="value">${q.graded ? p1(q.hitRate) : '-'}</span><span class="sub">${q.graded ? 'lower bound ' + p1(q.lowerBound) : 'no graded calls yet'}</span></div>
          <div class="tile"><span class="label">Avg vs benchmark</span><span class="value ${cls(q.avgExcess)}">${q.graded ? D.pct(q.avgExcess, 1) : '-'}</span><span class="sub">per call, ${D.HORIZON[q.id] ?? 63} days</span></div>
        </div>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><b>Mode</b>${seg('qmode', q.mode, [['live', 'Live'], ['paper', 'Paper'], ['off', 'Off']], `data-q="${q.id}"`)}
          <span class="muted" style="font-size:12px">Live: proposals go to your queue. Paper: calls are recorded and graded but never queued. Off: not run.</span></div>
        ${capField}
      </div>
      <ul class="rules">${(q.id === 'mom' && D.isReplay(s) ? REPLAY_RULES(ui.backtest) : q.id === 'mr' ? MR_RULES(ui.backtest) : q.id === 'cry' ? CRY_RULES(ui.backtest) : RULES[q.id]).map(r => `<li>${esc(r)}</li>`).join('')}</ul>`)}
      <div class="cols-2">
        ${panel({ mom: D.isReplay(s) ? 'Rotation ranking' : "Today's ranking", mr: 'Dip scan', cry: 'Trend check' }[q.id] || "Today's review", 'from the latest closes', todayView(s, q))}
        ${panel('Call history', `graded ${D.HORIZON[q.id] ?? 63} trading days after each call`, history(s, q))}
      </div>`;
  }).join('');
  const planned = PLANNED.map(([n, d]) => `<div class="statecard"><b>${n}</b><span>${esc(d)}</span></div>`).join('');
  return `<div class="desk-head"><h1>Quants</h1><p>Each quant proposes; you decide. Its record is built from every call it makes, approved or not, graded against the benchmark.</p></div>
    ${ui.formError ? `<div class="down" role="alert">${esc(ui.formError)}</div>` : ''}
    ${cards}
    ${panel('Not built: no honest way to test them yet', '', planned)}`;
}
