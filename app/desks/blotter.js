// Blotter: every order and the manager's own trade ticket.

import * as D from '../desk.js';
import { DEFAULT_UNIVERSE } from '../../src/quants/momentum.js';
import { esc, panel, seg } from '../ui.js';

export const STATUSES = ['all', 'pending', 'filled', 'rejected', 'expired', 'cancelled'];

function ticket(s, ui) {
  const d = ui.drafts;
  const held = Object.keys(s.account.positions);
  const symbols = [...new Set([...held, ...DEFAULT_UNIVERSE, ...D.CRYPTO, 'SPY'])].sort();
  const sym = d['t-sym'] || symbols[0], side = d['t-side'] || 'buy', qty = d['t-qty'] ?? '';
  const pv = D.previewManual(s, { symbol: sym, side, qty });
  const checks = pv ? `<div class="checks">${pv.checks.filter(c => !c.ok || !['halted', 'valid'].includes(c.id)).map(c => `<span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✕'} ${esc(c.message)}</span>`).join('')}</div>` : '';
  return `<div class="ticket">
      <div><label for="t-sym">Symbol</label><select id="t-sym" data-draft>${symbols.map(x => `<option ${x === sym ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div><label for="t-side">Side</label><select id="t-side" data-draft><option value="buy" ${side === 'buy' ? 'selected' : ''}>Buy</option><option value="sell" ${side === 'sell' ? 'selected' : ''}>Sell</option></select></div>
      <div><label for="t-qty">Quantity</label><input id="t-qty" data-draft inputmode="decimal" placeholder="${D.CRYPTO.includes(sym) ? '0.01' : '10'}" value="${esc(qty)}"></div>
      <div class="full"><span class="num">${D.usd(s.sim.prices[sym], 2)} now${s.account.positions[sym] ? ` · you hold ${D.fmtQty({ symbol: sym, qty: s.account.positions[sym].qty })}` : ''}${pv ? ` · order ~${D.usd(pv.value)}` : ''}</span></div>
      ${pv ? `<div class="full">${checks}</div>` : ''}
      ${ui.ticketMsg ? `<div class="full ${ui.ticketMsg.ok ? 'up' : 'down'}" role="status">${esc(ui.ticketMsg.text)}</div>` : ''}
      <div class="full actions"><button class="btn primary" data-act="submitTicket" ${pv && pv.approved && D.marketOpen(s) ? '' : 'disabled'}>Place ${side} order</button>
        <span class="muted" style="font-size:12px">Fills immediately at the current price if every risk check passes.</span></div>
    </div>`;
}

export function renderBlotter(s, ui) {
  const f = ui.blotterFilter || 'all';
  const counts = Object.fromEntries(STATUSES.map(st => [st, st === 'all' ? s.orders.length : s.orders.filter(o => o.status === st).length]));
  const list = s.orders.filter(o => f === 'all' || o.status === f).slice(0, 200);
  const rows = list.map(o => {
    const price = o.fillPrice ?? s.sim.prices[o.symbol];
    return `<tr><td class="num">#${o.id}</td><td class="num">${o.filledAt || o.created}</td>
      <td><span class="side ${o.side}" style="font-size:13px">${o.side.toUpperCase()}</span> <span class="sym">${o.symbol}</span></td>
      <td class="r num">${D.fmtQty(o)}${o.proposedQty && o.proposedQty !== o.qty ? `<div class="qdesc">proposed ${o.proposedQty}</div>` : ''}</td>
      <td class="r num">${D.usd(price, 2)}${o.fillPrice ? '' : '<div class="qdesc">now</div>'}</td>
      <td class="r num">${D.usd(price * o.qty)}</td>
      <td>${D.quantName(o.quantId)}</td>
      <td><span class="ostatus ${o.status}">${o.status}</span>${o.approvedBy ? `<div class="qdesc">${o.approvedBy === 'auto' ? 'auto' : 'by you'}</div>` : ''}</td>
      <td class="r num ${o.realized == null ? '' : o.realized >= 0 ? 'up' : 'down'}">${o.realized == null ? '' : (o.realized >= 0 ? '+' : '') + D.usd(o.realized)}</td></tr>`;
  }).join('');
  return `<div class="desk-head"><h1>Blotter</h1><p>Every order the desk has seen. Your own trades go through the same risk manager as the quants'.</p></div>
    ${panel('Trade ticket', D.marketOpen(s) ? 'market open' : 'market closed', ticket(s, ui))}
    ${panel('Orders', `${list.length} shown`, `<div class="search">${seg('bfilter', f, STATUSES.map(st => [st, `${st} (${counts[st]})`]))}</div>
      ${list.length ? `<div class="tablewrap"><table><thead><tr><th>Id</th><th>Time</th><th>Order</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Value</th><th>Source</th><th>Status</th><th class="r">Realized</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty">No orders in this view.</div>'}`)}`;
}
