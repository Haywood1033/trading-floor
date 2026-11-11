// Floor desk: the manager's overview. Pure HTML builders over desk state.
// Each panel carries a data-panel key so the app can redraw only the panels that changed.

import * as D from './desk.js';
import { esc, cls, p1, gauge, tierChip } from './ui.js';

const SPARK_DAYS = 63; // about three months of closes

function spark(points) {
  const W = 300, H = 64, pad = 4;
  if (points.length < 2) points = [points[0] ?? 0, points[0] ?? 0];
  const base = points[0];
  const lo = Math.min(...points), hi = Math.max(...points);
  const y = v => H - pad - (v - lo) / (hi - lo || 1) * (H - pad * 2);
  const x = i => i / (points.length - 1) * W;
  const line = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const lastX = x(points.length - 1), lastY = y(points.at(-1));
  const col = points.at(-1) >= base ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="NAV over the last ${points.length} closes">
    <line x1="0" x2="${W}" y1="${y(base)}" y2="${y(base)}" stroke="var(--muted)" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke" opacity=".6"/>
    <path d="${line}L${lastX},${H}L0,${H}Z" fill="${col}" opacity=".12"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <circle cx="${lastX}" cy="${lastY}" r="2.5" fill="${col}"/></svg>`;
}

function portfolioPanel(s) {
  const t = D.totals(s);
  const day = t.equity - s.prevEquity;
  const since = t.equity / s.fund.capital - 1;
  let unreal = 0;
  const rows = Object.entries(s.account.positions).map(([sym, p]) => {
    const price = s.sim.prices[sym], prev = s.sim.prevClose?.[sym] ?? price;
    const value = p.qty * price, u = value - p.costBasis; unreal += u;
    const w = value / t.equity;
    const chips = (p.assetClass === 'crypto' ? '<span class="chip crypto">crypto</span>' : '') +
      (D.positionCap(s, p) != null && w > D.positionCap(s, p) + 1e-9 ? '<span class="chip over">over limit</span>' : '');
    return { value, html: `<tr><td><span class="sym">${sym}</span>${chips}<div class="muted num" style="font-size:11px">${D.fmtQty({ symbol: sym, qty: p.qty })} · ${p1(w)}</div></td>
      <td class="r num">${D.usd(value)}</td><td class="r num ${cls(price / prev - 1)}">${D.pct(price / prev - 1, 1)}</td><td class="r num ${cls(u)}">${u >= 0 ? '+' : ''}${D.usd(u)}</td></tr>` };
  }).sort((a, b) => b.value - a.value);
  const recent = s.curve.daily.slice(-SPARK_DAYS).map(d => d.equity);
  return `<section class="panel" data-panel="fund"><h2>Fund <small>${esc(s.fund.name)}</small></h2>
    <div class="pad">
      <div class="big">${D.usd(t.equity, 2)}</div>
      <div class="num"><span class="${cls(day)}">${day >= 0 ? '+' : ''}${D.usd(day, 2)} (${D.pct(day / s.prevEquity)})</span> <span class="muted">on the day</span></div>
      ${spark(recent)}
      <div class="muted" style="font-size:11px">Last ${recent.length} close${recent.length === 1 ? '' : 's'}</div>
      <dl class="kv">
        <dt>Cash</dt><dd class="num">${D.usd(t.cash)} · ${p1(t.cash / t.equity)}</dd>
        <dt>Invested</dt><dd class="num">${D.usd(t.stocks + t.crypto)}</dd>
        <dt>Unrealized P&amp;L</dt><dd class="num ${cls(unreal)}">${unreal >= 0 ? '+' : ''}${D.usd(unreal)}</dd>
        <dt>Realized P&amp;L</dt><dd class="num ${cls(s.account.realized)}">${s.account.realized >= 0 ? '+' : ''}${D.usd(s.account.realized)}</dd>
        <dt>Dividends · costs</dt><dd class="num">${D.usd(s.account.dividends || 0, 2)} · <span class="down">${D.usd(-(s.account.fees || 0), 2)}</span></dd>
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
    ? `<div class="autoline">${r.auto.auto ? 'Auto: will approve.' : 'Auto: waiting for you. ' + esc(r.auto.reasons.join('; '))}</div>` : '';
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
  const list = D.pending(s), work = D.approved(s);
  const next = D.nextDate(s);
  const empty = s.kill.halted ? 'Trading is halted. Resume to let quants propose again at the next close.'
    : s.sim.ended ? 'The replay has reached the latest data. It continues when the price history updates.'
    : `Nothing waiting. Quants look at each close; proposals you don't answer expire at the next close${D.daysToRebalance(s) ? ` (rotation rebalances in ${D.daysToRebalance(s)} trading day${D.daysToRebalance(s) === 1 ? '' : 's'})` : ''}.`;
  const workRows = work.map(o => `<li><span class="side ${o.side}">${o.side === 'buy' ? '▲' : '▼'}</span> <b>${o.symbol}</b> <span class="num">${D.fmtQty(o)}</span>
      <span class="muted">${D.quantName(o.quantId)}${o.approvedBy === 'auto' ? ' · auto' : ''}</span><span class="spacer"></span>
      <button class="btn ghost small" data-act="cancel" data-id="${o.id}">Cancel</button></li>`).join('');
  return `<section class="panel queue-panel" data-panel="queue"><h2>Approval queue <small>${list.length ? `${list.length} waiting · decide by the next close` : ''}</small></h2>
    ${list.length ? list.map(o => orderCard(s, o)).join('') : `<div class="empty">${empty}</div>`}
    ${work.length ? `<h3 class="subhead">Approved, filling at the next close${next ? ` (${next})` : ''}</h3><ul class="working">${workRows}</ul>
      <div class="gnote pad">Fill prices are the next close; the risk manager checks each order again at that price.</div>` : ''}</section>`;
}

function riskPanel(s) {
  const L = s.settings.limits, t = D.totals(s);
  const day = t.equity / s.prevEquity - 1;
  const tech = (t.bySector.Tech || 0) / t.equity;
  const peak = s.drawdownPeak ?? s.peakEquity;
  const breaker = s.breaker
    ? `<div class="gauge breaker"><div class="gtop"><span>Drawdown breaker</span><span class="num down">Tripped ${esc(s.breaker.trippedOn)}</span></div>
        <div class="gnote">Buys paused until ${esc(s.breaker.untilDate)} (${Math.max(0, s.breaker.until - s.daysRun)} trading days). Sells still allowed.</div>
        <button class="btn small" data-act="rearm">Re-arm now</button></div>`
    : L.maxDrawdownPct != null ? gauge('Drawdown from peak', Math.max(0, 1 - t.equity / peak), L.maxDrawdownPct, p1, `Breaker trips at -${p1(L.maxDrawdownPct)} and pauses buys for ${L.drawdownCooldownDays ?? 21} trading days.`)
    : '<div class="gauge"><div class="gtop"><span>Drawdown breaker</span><span class="num">off</span></div></div>';
  return `<section class="panel" data-panel="risk"><h2>Risk <small>hard limits</small></h2>
    ${gauge('Daily loss', Math.max(0, -day), -L.dailyLossLimitPct, p1, day >= 0 ? `Up ${p1(day)} on the day. New buys stop at ${p1(L.dailyLossLimitPct)}.` : `New buys stop at ${p1(L.dailyLossLimitPct)}.`)}
    ${breaker}
    ${(lg => gauge('Largest position vs its cap', lg ? lg.weight : 0, lg ? lg.cap : L.maxPositionPct, p1, lg ? `${lg.sym} (${s.account.positions[lg.sym].assetClass === 'etf' ? 'ETF cap' : 'single-stock cap'})` : 'No positions'))(D.largestVsCap(s))}
    ${L.sectorLimits?.Tech != null ? gauge('Tech exposure', tech, L.sectorLimits.Tech, p1) : `<div class="gauge"><div class="gtop"><span>Tech exposure</span><span class="num">${p1(tech)} · no cap</span></div></div>`}
    ${gauge('Crypto exposure', t.crypto / t.equity, L.maxCryptoPct, p1)}
    <div class="gauge"><div class="gtop"><span>Cash floor</span><span class="num">${p1(t.cash / t.equity)} / min ${p1(L.minCashPct)}</span></div></div>
    <div class="gauge"><div class="gtop"><span>Largest buy</span><span class="num">${D.usd(D.orderCapNow(s))}${L.maxOrderValue == null ? ` · ${p1(L.maxOrderPct)} of NAV` : ''}</span></div>
      <div class="gtop"><span>Auto-approve cap</span><span class="num">${D.usd(D.autoCapNow(s))}${L.autoMaxOrderValue == null ? ` · ${p1(L.autoMaxOrderPct)} of NAV` : ''}</span></div>
      <div class="gnote">Sells are never capped by size. Auto mode only for quants rated ${L.autoTiers.join(', ')}.</div></div>
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
  return `<section class="panel" data-panel="bench"><h2>Quant bench <small>each call graded at its horizon vs SPY</small></h2>
    <div class="tablewrap"><table><thead><tr><th>Quant</th><th>Record</th><th>Tier</th><th class="r">Mode</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function logPanel(s) {
  return `<section class="panel" data-panel="log"><h2>Activity log <small>audit trail</small></h2>
    <ul class="log">${s.log.slice(0, 60).map(e => `<li><time>${esc(e.at)}</time><span class="tag ${e.kind}">${e.kind}</span><span>${esc(e.text)}</span></li>`).join('')}</ul></section>`;
}

export function renderFloor(s) {
  return `<div class="grid-floor">${portfolioPanel(s)}${queuePanel(s)}${riskPanel(s)}</div>
    <div class="grid-lower">${benchPanel(s)}${logPanel(s)}</div>`;
}
