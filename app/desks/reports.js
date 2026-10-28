// Reports: daily brief, performance by quant, monthly summary.

import * as D from '../desk.js';
import { esc, cls, p1, panel, lineChart, tierChip, seg } from '../ui.js';

const pc = v => (v * 100).toFixed(1) + '%';
// The fair backtest from state/backtest-etf.json, with a plain-language reading of it.
function backtestPanel(bt, ui) {
  if (!bt?.periods) return panel('Fair backtest', '', '<div class="empty">Backtest results did not load.</div>');
  const pid = ui.btPeriod || 'full';
  const per = bt.periods[pid];
  const by = id => per.strategies.find(x => x.id === id);
  const spy = by('spy'), m = by('mom3');
  const rows = per.strategies.map(x => `<tr class="${x.id === 'mom3' ? 'hl' : ''}"><td><b>${esc(x.name)}</b><div class="qdesc">${esc(x.note)}</div></td>
    <td class="r num ${cls(x.cagr - spy.cagr)}">${pc(x.cagr)}</td><td class="r num">${pc(x.vol)}</td><td class="r num">${x.sharpe.toFixed(2)}</td>
    <td class="r num down">${pc(x.maxDrawdown)}<div class="qdesc">${x.drawdownFrom?.slice(0, 7)} to ${x.drawdownTo?.slice(0, 7)}</div></td>
    <td class="r num">${x.worstYear?.year} <span class="${cls(x.worstYear?.ret)}">${pc(x.worstYear?.ret ?? 0)}</span></td>
    <td class="r num">$${Math.round(x.growthOf10k).toLocaleString('en-US')}</td><td class="r num">${x.turnoverPerYear.toFixed(1)}×</td></tr>`).join('');
  const verdict = m.cagr > spy.cagr
    ? `Over this period the rotation returned more than SPY (${pc(m.cagr)} vs ${pc(spy.cagr)} a year) with a ${pc(m.maxDrawdown)} worst drop against SPY's ${pc(spy.maxDrawdown)}.`
    : `Over this period the rotation returned less than simply holding SPY (${pc(m.cagr)} vs ${pc(spy.cagr)} a year). What it offered instead was a smaller worst drop: ${pc(m.maxDrawdown)} against SPY's ${pc(spy.maxDrawdown)}.`;
  const full = bt.periods.full.strategies;
  const curve = id => full.find(x => x.id === id)?.curve || [];
  const c = curve('spy');
  const chart = lineChart([
    { name: 'SPY', color: 'var(--muted)', dash: true, values: c.map(p => p[1] / 1000) },
    { name: 'Rotation top 3', color: 'var(--accent)', values: curve('mom3').map(p => p[1] / 1000) },
    { name: '60/40', color: 'var(--up)', values: curve('6040').map(p => p[1] / 1000) }
  ], [c[0]?.[0], c.at(-1)?.[0]], { fmtY: v => '$' + v.toFixed(0) + 'k' });
  return panel('Fair backtest', `ETFs, ${bt.start} to ${bt.dataThrough}, ${bt.costBps} bps per trade, next-day execution`, `
    <div class="search">${seg('btPeriod', pid, Object.entries(bt.periods).map(([k, v]) => [k, v.label]))}</div>
    <div class="brief"><p>${verdict}</p>
      <p class="muted">Growth of $10,000, full period. Every fund here traded the whole time, so the list isn't picked with hindsight. Past results are not a forecast.</p></div>
    ${pid === 'full' ? chart : ''}
    <div class="tablewrap"><table><thead><tr><th>Strategy</th><th class="r">Per year</th><th class="r">Volatility</th><th class="r">Sharpe</th><th class="r">Worst drop</th><th class="r">Worst year</th><th class="r">$10k became</th><th class="r">Turnover</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function brief(s, day) {
  const entries = s.log.filter(e => e.at.startsWith(day)).reverse();
  const idx = s.curve.daily.findIndex(x => x.date === day);
  const close = s.curve.daily[idx];
  const prevEq = idx > 0 ? s.curve.daily[idx - 1].equity : s.fund.capital;
  const prevSpy = idx > 0 ? s.curve.daily[idx - 1].spy : s.fund.spyStart;
  const fills = entries.filter(e => e.kind === 'fill');
  const vetoes = entries.filter(e => e.kind === 'veto');
  const signals = entries.filter(e => e.kind === 'signal' || e.kind === 'paper');
  const other = entries.filter(e => e.kind === 'system' && /Graded|limits|resumed|Switched|set to|capital cap/.test(e.text));
  const halts = entries.filter(e => e.kind === 'halt');
  const expired = entries.map(e => e.text.match(/(\d+) unapproved order/)).find(Boolean);
  const fundRet = close ? close.equity / prevEq - 1 : null;
  const spyRet = close && close.spy && prevSpy ? close.spy / prevSpy - 1 : null;
  const list = (title, items) => (items.length ? `<p><b>${title}</b></p><ul class="rules">${items.map(e => `<li>${esc(e.text)}</li>`).join('')}</ul>` : '');
  return `<div class="brief">
    ${close ? `<p>The fund closed at <b class="num">${D.usd(close.equity)}</b>, <span class="${cls(fundRet)}">${D.pct(fundRet)}</span> on the day${spyRet != null ? `, against SPY <span class="${cls(spyRet)}">${D.pct(spyRet)}</span>` : ''}.</p>` : '<p>This day has not closed yet.</p>'}
    <p>${fills.length} trade${fills.length === 1 ? '' : 's'} filled, ${vetoes.length} blocked by risk${expired ? `, ${expired[1]} proposal${expired[1] === '1' ? '' : 's'} expired unapproved` : ''}.</p>
    ${list('Quants', signals)}${list('Trades', fills)}${list('Blocked', vetoes)}${list('Kill switch', halts)}${list('Other', other)}
  </div>`;
}

export function renderReports(s, ui) {
  const closed = s.curve.daily.map(d => d.date).reverse();
  const day = ui.drafts.briefDay && closed.includes(ui.drafts.briefDay) ? ui.drafts.briefDay : closed[0];
  const dailyBrief = closed.length
    ? `<div class="search"><label for="briefDay" class="muted" style="align-self:center">Day</label><select id="briefDay" data-draft>${closed.slice(0, 60).map(x => `<option ${x === day ? 'selected' : ''}>${x}</option>`).join('')}</select></div>${brief(s, day)}`
    : '<div class="empty">The first brief appears after the first simulated close. Use "Skip to close" to get there.</div>';

  // Performance by quant
  const eq = D.totals(s).equity;
  const board = D.scoreboard(s);
  const sources = [...board.map(q => ({ id: q.id, name: q.name, q })), { id: 'manager', name: 'Manager (your tickets)' }];
  const rows = sources.map(src => {
    const realized = s.orders.filter(o => o.status === 'filled' && o.side === 'sell' && (o.attribution || 'manager') === src.id).reduce((a, o) => a + (o.realized || 0), 0);
    let unreal = 0, value = 0;
    for (const [sym, p] of Object.entries(s.account.positions)) if ((p.openedBy || 'manager') === src.id) { const v = p.qty * s.sim.prices[sym]; value += v; unreal += v - p.costBasis; }
    const trades = s.orders.filter(o => o.status === 'filled' && o.quantId === src.id).length;
    return `<tr><td><b>${src.name}</b></td><td class="r num">${trades}</td><td class="r num">${D.usd(value)}<div class="qdesc">${p1(value / eq)} of NAV</div></td>
      <td class="r num ${cls(realized)}">${realized >= 0 ? '+' : ''}${D.usd(realized)}</td><td class="r num ${cls(unreal)}">${unreal >= 0 ? '+' : ''}${D.usd(unreal)}</td>
      <td class="r num">${src.q ? (src.q.graded ? `${p1(src.q.hitRate)} of ${src.q.graded}` : '0 graded') : '-'}</td><td>${src.q ? tierChip(src.q.tier) : ''}</td></tr>`;
  }).join('');
  const perf = `<div class="tablewrap"><table><thead><tr><th>Source</th><th class="r">Trades</th><th class="r">Holding now</th><th class="r">Realized</th><th class="r">Unrealized</th><th class="r">Calls right</th><th>Tier</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pad muted" style="font-size:12px">P&amp;L is credited to whoever opened the position. "Calls right" counts every call, traded or not.</div>`;

  // Monthly
  const months = {};
  let prev = { equity: s.fund.capital, spy: s.fund.spyStart };
  for (const d of s.curve.daily) {
    const m = d.date.slice(0, 7);
    months[m] ||= { start: prev, end: d, days: 0 };
    months[m].end = d; months[m].days++;
    prev = d;
  }
  const mrows = Object.entries(months).reverse().map(([m, x]) => {
    const fr = x.end.equity / x.start.equity - 1, sr = x.end.spy && x.start.spy ? x.end.spy / x.start.spy - 1 : null;
    const trades = s.orders.filter(o => o.status === 'filled' && o.filledAt?.startsWith(m)).length;
    return `<tr><td class="num">${m}</td><td class="r num">${x.days}</td><td class="r num">${D.usd(x.end.equity)}</td><td class="r num ${cls(fr)}">${D.pct(fr)}</td>
      <td class="r num ${sr == null ? '' : cls(sr)}">${sr == null ? '-' : D.pct(sr)}</td><td class="r num ${sr == null ? '' : cls(fr - sr)}">${sr == null ? '-' : (fr - sr >= 0 ? '+' : '') + ((fr - sr) * 100).toFixed(2) + ' pts'}</td><td class="r num">${trades}</td></tr>`;
  }).join('');
  const monthly = mrows ? `<div class="tablewrap"><table><thead><tr><th>Month</th><th class="r">Days</th><th class="r">End NAV</th><th class="r">Fund</th><th class="r">SPY</th><th class="r">vs SPY</th><th class="r">Trades</th></tr></thead><tbody>${mrows}</tbody></table></div>`
    : '<div class="empty">Fills in as simulated days close.</div>';

  const chart = lineChart([
    { name: 'Fund', color: 'var(--accent)', values: [s.fund.capital, ...s.curve.daily.map(d => d.equity)].map(v => v / s.fund.capital * 100) },
    { name: 'SPY', color: 'var(--muted)', dash: true, values: [s.fund.spyStart, ...s.curve.daily.map(d => d.spy ?? null)].map(v => (v == null ? null : v / s.fund.spyStart * 100)) }
  ], [s.fund.inception, s.curve.daily.at(-1)?.date || ''], { fmtY: v => v.toFixed(1) });

  return `<div class="desk-head"><h1>Reports</h1><p>The evidence behind the strategy, what the desk did, and how the fund is doing.</p></div>
    ${backtestPanel(ui.backtest, ui)}
    ${panel('Daily brief', closed.length ? `${closed.length} closed day${closed.length === 1 ? '' : 's'}` : '', dailyBrief)}
    ${panel('Fund vs SPY', 'indexed to 100 at inception', chart)}
    ${panel('Performance by source', '', perf)}
    ${panel('Monthly summary', '', monthly)}`;
}
