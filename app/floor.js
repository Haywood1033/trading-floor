// Floor desk: the manager's overview. Pure HTML builders over desk state.

import * as D from './desk.js';
import { TICKS_PER_DAY } from './sim.js';
import { esc, cls, p1, gauge, tierChip } from './ui.js';

function spark(points, base) {
  const W = 300, H = 64, pad = 4;
  if (points.length < 2) points = [base, base];
  const lo = Math.min(...points, base), hi = Math.max(...points, base);
  const y = v => H - pad - (v - lo) / (hi - lo || 1) * (H - pad * 2);
  const x = i => i / (TICKS_PER_DAY) * W;
  const line = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const lastX = x(points.length - 1), lastY = y(points.at(-1));
  const col = points.at(-1) >= base ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="NAV today">
    <line x1="0" x2="${W}" y1="${y(base)}" y2="${y(base)}" stroke="var(--muted)" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke" opacity=".6"/>
    <path d="${line}L${lastX},${H}L0,${H}Z" fill="${col}" opacity=".12"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <circle cx="${lastX}" cy="${lastY}" r="2.5" fill="${col}"/></svg>`;
}

function portfolioPanel(s) {
  const t = D.totals(s);
  const day = t.equity - s.startOfDayEquity;
  const since = t.equity / s.fund.capital - 1;
  let unreal = 0;
  const rows = Object.entries(s.account.positions).map(([sym, p]) => {
    const price = s.sim.prices[sym], prev = s.sim.history[sym].at(-1);
    const value = p.qty * price, u = value - p.costBasis; unreal += u;
    const w = value / t.equity;
    const chips = (p.assetClass === 'crypto' ? '<span class="chip crypto">crypto</span>' : '') +
      (p.assetClass !== 'crypto' && w > s.settings.limits.maxPositionPct ? '<span class="chip over">over limit</span>' : '');
    return { value, html: `<tr><td><span class="sym">${sym}</span>${chips}<div class="muted num" style="font-size:11px">${D.fmtQty({ symbol: sym, qty: p.qty })} · ${p1(w)}</div></td>
      <td class="r num">${D.usd(value)}</td><td class="r num ${cls(price / prev - 1)}">${D.pct(price / prev - 1, 1)}</td><td class="r num ${cls(u)}">${u >= 0 ? '+' : ''}${D.usd(u)}</td></tr>` };
  }).sort((a, b) => b.value - a.value);
  return `<section class="panel"><h2>Fund <small>${esc(s.fund.name)}</small></h2>
    <div class="pad">
      <div class="big">${D.usd(t.equity, 2)}</div>
      <div class="num"><span class="${cls(day)}">${day >= 0 ? '+' : ''}${D.usd(day, 2)} (${D.pct(day / s.startOfDayEquity)})</span> <span class="muted">today</span></div>
      ${spark(s.curve.intraday, s.startOfDayEquity)}
      <dl class="kv">
        <dt>Cash</dt><dd class="num">${D.usd(t.cash)} · ${p1(t.cash / t.equity)}</dd>
        <dt>Invested</dt><dd class="num">${D.usd(t.stocks + t.crypto)}</dd>
        <dt>Unrealized P&amp;L</dt><dd class="num ${cls(unreal)}">${unreal >= 0 ? '+' : ''}${D.usd(unreal)}</dd>
        <dt>Realized P&amp;L</dt><dd class="num ${cls(s.account.realized)}">${s.account.realized >= 0 ? '+' : ''}${D.usd(s.account.realized)}</dd>
        <dt>Since inception</dt><dd class="num ${cls(since)}">${D.pct(since)}</dd>
      </dl>
    </div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Holding</th><th class="r">Value</th><th class="r">Day</th><th class="r">P&amp;L</th></tr></thead><tbody>${rows.map(r => r.html).join('')}</tbody></table></div>`
                  : '<div class="empty">No positions yet. Approve proposals to put cash to work.</div>'}
  </section>`;
}

function orderCard(s, o) {
  const r = D.riskFor(s, o);
  const auto = s.settings.mode === 'auto'
    ? `<div class="autoline">${r.auto.auto ? 'Auto: will fill on the next step.' : 'Auto: waiting for you. ' + esc(r.auto.reasons.join('; '))}</div>` : '';
  return `<article class="order ${r.approved ? 'ready' : 'blocked'}" data-id="${o.id}">
    <div class="otop">
      <span class="side ${o.side}">${o.side === 'buy' ? '▲ BUY' : '▼ SELL'}</span>
      <span class="sym">${o.symbol}</span>
      <span class="qty num"><button data-act="dec" data-id="${o.id}" aria-label="Decrease size">−</button><span>${D.fmtQty(o)}</span><button data-act="inc" data-id="${o.id}" aria-label="Increase size">+</button></span>
      <span class="num muted">~${D.usd(r.value)} @ ${D.usd(r.price, 2)}</span>
      <span class="spacer"></span>
      <span class="muted" style="font-size:12px">${D.quantName(o.quantId)}${o.confidence != null ? ` · conf ${Math.round(o.confidence * 100)}%` : ''}</span>
    </div>
    <div class="thesis">${esc(o.thesis)}</div>
    <div class="checks">${r.checks.filter(c => !c.ok || !['halted', 'valid'].includes(c.id)).map(c => `<span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✕'} ${esc(c.message)}</span>`).join('')}</div>
    ${auto}
    <div class="actions">
      <button class="btn primary" data-act="approve" data-id="${o.id}" ${r.approved && D.marketOpen(s) ? '' : 'disabled'}>Approve</button>
      ${r.fit ? `<button class="btn" data-act="fit" data-id="${o.id}">Resize to ${r.fit}</button>` : ''}
      <button class="btn ghost" data-act="reject" data-id="${o.id}">Reject</button>
    </div>
  </article>`;
}

function queuePanel(s) {
  const list = D.pending(s);
  const empty = s.kill.halted ? 'Trading is halted. Resume to let quants propose again at the next open.'
    : 'Nothing waiting. Quants scan at each market open; anything not approved expires at the close.';
  return `<section class="panel queue-panel"><h2>Approval queue <small>${list.length ? list.length + ' waiting · expire at 4:00 PM' : ''}</small></h2>
    ${list.length ? list.map(o => orderCard(s, o)).join('') : `<div class="empty">${empty}</div>`}</section>`;
}

function riskPanel(s) {
  const L = s.settings.limits, t = D.totals(s), snap = D.snapshot(s);
  const day = t.equity / s.startOfDayEquity - 1;
  const stocks = Object.entries(snap.positions).filter(([, p]) => p.assetClass !== 'crypto');
  const big = stocks.reduce((m, [sym, p]) => (p.qty * p.price > (m?.v || 0) ? { sym, v: p.qty * p.price } : m), null);
  const tech = (t.bySector.Tech || 0) / t.equity;
  return `<section class="panel"><h2>Risk <small>hard limits</small></h2>
    ${gauge('Daily loss', Math.max(0, -day), -L.dailyLossLimitPct, p1, day >= 0 ? `Up ${p1(day)} today. New buys stop at ${p1(L.dailyLossLimitPct)}.` : `New buys stop at ${p1(L.dailyLossLimitPct)}.`)}
    ${gauge('Largest stock position', big ? big.v / t.equity : 0, L.maxPositionPct, p1, big ? big.sym : 'No stock positions')}
    ${gauge('Tech exposure', tech, L.sectorLimits.Tech, p1)}
    ${gauge('Crypto exposure', t.crypto / t.equity, L.maxCryptoPct, p1)}
    ${gauge('Drawdown from peak', Math.max(0, 1 - t.equity / s.peakEquity), L.maxDrawdownPct, p1, `Peak NAV ${D.usd(s.peakEquity)}.`)}
    <div class="gauge"><div class="gtop"><span>Cash floor</span><span class="num">${p1(t.cash / t.equity)} / min ${p1(L.minCashPct)}</span></div></div>
    <div class="gauge"><div class="gtop"><span>Max order</span><span class="num">${D.usd(L.maxOrderValue)}</span></div>
      <div class="gtop"><span>Auto-trade cap</span><span class="num">${D.usd(L.autoMaxOrderValue)}</span></div>
      <div class="gnote">Auto mode only for quants rated ${L.autoTiers.join(', ')}.</div></div>
    <div class="pad"><a class="link" href="#risk">Edit limits on the Risk desk →</a></div>
  </section>`;
}

function benchPanel(s) {
  const rows = D.scoreboard(s).map(q => `<tr>
    <td><b>${q.name}</b><div class="qdesc">${esc(q.desc)}</div></td>
    <td class="num">${q.graded ? `${p1(q.hitRate)} <span class="muted">of ${q.graded}</span>` : `<span class="muted">0 graded</span>`}<div class="qdesc">${q.open} open call${q.open === 1 ? '' : 's'}</div></td>
    <td>${tierChip(q.tier)}</td>
    <td class="r"><div class="seg small" role="group" aria-label="${q.name} mode">${['live', 'paper', 'off'].map(m =>
      `<button data-act="qmode" data-q="${q.id}" data-v="${m}" aria-pressed="${q.mode === m}">${m}</button>`).join('')}</div></td></tr>`).join('');
  return `<section class="panel"><h2>Quant bench <small>calls graded after 63 trading days vs SPY</small></h2>
    <div class="tablewrap"><table><thead><tr><th>Quant</th><th>Record</th><th>Tier</th><th class="r">Mode</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function logPanel(s) {
  return `<section class="panel"><h2>Activity log <small>audit trail</small></h2>
    <ul class="log">${s.log.slice(0, 60).map(e => `<li><time>${e.at}</time><span class="tag ${e.kind}">${e.kind}</span><span>${esc(e.text)}</span></li>`).join('')}</ul></section>`;
}

export function renderFloor(s) {
  return `<div class="grid-floor">${portfolioPanel(s)}${queuePanel(s)}${riskPanel(s)}</div>
    <div class="grid-lower">${benchPanel(s)}${logPanel(s)}</div>`;
}
