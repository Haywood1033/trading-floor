// Portfolio desk: every holding, allocation, and the fund against SPY.

import * as D from '../desk.js';
import { esc, cls, p1, signed, panel, bars, lineChart } from '../ui.js';

export function renderPortfolio(s) {
  const t = D.totals(s);
  const spyNow = s.sim.prices.SPY;
  const fundRet = t.equity / s.fund.capital - 1;
  const spyRet = spyNow / s.fund.spyStart - 1;
  let unreal = 0;
  const rows = Object.entries(s.account.positions).map(([sym, p]) => {
    const price = s.sim.prices[sym], prev = s.sim.history[sym].at(-1);
    const value = p.qty * price, u = value - p.costBasis; unreal += u;
    return { sym, p, price, prev, value, u, w: value / t.equity, avg: p.costBasis / p.qty };
  }).sort((a, b) => b.value - a.value);

  const tiles = `<div class="tiles">
    <div class="tile"><span class="label">NAV</span><span class="value">${D.usd(t.equity)}</span><span class="sub">Started ${D.usd(s.fund.capital)} on ${s.fund.inception}</span></div>
    <div class="tile"><span class="label">Since inception</span><span class="value ${cls(fundRet)}">${D.pct(fundRet)}</span><span class="sub">SPY ${D.pct(spyRet)} · ${signed((fundRet - spyRet) * 100, v => v.toFixed(2))} pts vs SPY</span></div>
    <div class="tile"><span class="label">Unrealized P&amp;L</span><span class="value ${cls(unreal)}">${signed(unreal, v => D.usd(v))}</span><span class="sub">${rows.length} position${rows.length === 1 ? '' : 's'}</span></div>
    <div class="tile"><span class="label">Realized P&amp;L</span><span class="value ${cls(s.account.realized)}">${signed(s.account.realized, v => D.usd(v))}</span><span class="sub">From closed and trimmed positions</span></div>
    <div class="tile"><span class="label">Cash</span><span class="value">${D.usd(t.cash)}</span><span class="sub">${p1(t.cash / t.equity)} of NAV</span></div>
    <div class="tile"><span class="label">Peak NAV</span><span class="value">${D.usd(s.peakEquity)}</span><span class="sub">${p1(t.equity / s.peakEquity - 1)} from peak</span></div>
  </div>`;

  const daily = s.curve.daily;
  const chart = lineChart([
    { name: 'Fund', color: 'var(--accent)', values: [s.fund.capital, ...daily.map(d => d.equity)].map(v => v / s.fund.capital * 100) },
    { name: 'SPY', color: 'var(--muted)', dash: true, values: [s.fund.spyStart, ...daily.map(d => d.spy ?? null)].map(v => (v == null ? null : v / s.fund.spyStart * 100)) }
  ], [s.fund.inception, daily.at(-1)?.date || ''], { fmtY: v => v.toFixed(1) });

  const byClass = [{ label: 'Cash', value: t.cash }, { label: 'Stocks', value: t.stocks }, { label: 'Crypto', value: t.crypto, cap: s.settings.limits.maxCryptoPct }].filter(r => r.value > 0 || r.label === 'Cash');
  const sectors = Object.entries(t.bySector).map(([label, value]) => ({ label, value, cap: s.settings.limits.sectorLimits?.[label] })).sort((a, b) => b.value - a.value);

  const table = rows.length ? `<div class="tablewrap"><table>
    <thead><tr><th>Holding</th><th class="r">Qty</th><th class="r">Avg cost</th><th class="r">Price</th><th class="r">Value</th><th class="r">Weight</th><th class="r">Day</th><th class="r">Unrealized</th><th>Opened</th><th></th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td><span class="sym">${r.sym}</span><div class="qdesc">${esc(r.p.sector)}</div></td>
      <td class="r num">${D.fmtQty({ symbol: r.sym, qty: r.p.qty })}</td>
      <td class="r num">${D.usd(r.avg, 2)}</td><td class="r num">${D.usd(r.price, 2)}</td>
      <td class="r num">${D.usd(r.value)}</td>
      <td class="r num ${D.positionCap(s, r.p) != null && r.w > D.positionCap(s, r.p) + 1e-9 ? 'down' : ''}">${p1(r.w)}</td>
      <td class="r num ${cls(r.price / r.prev - 1)}">${D.pct(r.price / r.prev - 1, 1)}</td>
      <td class="r num ${cls(r.u)}">${signed(r.u, v => D.usd(v))}<div class="qdesc">${D.pct(r.u / r.p.costBasis, 1)}</div></td>
      <td><span class="num">${r.p.opened}</span><div class="qdesc">${D.quantName(r.p.openedBy || 'manager')}</div></td>
      <td class="r"><button class="btn rowbtn" data-act="closepos" data-sym="${r.sym}" ${D.marketOpen(s) && !s.kill.halted ? '' : 'disabled'}>Close</button></td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">No positions yet. Approve proposals on the Floor, or place a trade from the Blotter.</div>';

  return `<div class="desk-head"><h1>Portfolio</h1><p>Every holding at the current simulated price. "Close" sells the whole position through the risk manager.</p></div>
    ${tiles}
    ${panel('Fund vs SPY', 'indexed to 100 at inception, daily closes', chart)}
    <div class="cols-2">
      ${panel('By asset class', '', bars(byClass, t.equity, v => D.usd(v)))}
      ${panel('By sector', 'marks show caps', bars(sectors, t.equity, v => D.usd(v)))}
    </div>
    ${panel('Positions', `${rows.length} open`, table)}`;
}
