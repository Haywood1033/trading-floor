// Risk desk: the manager edits every limit; live exposure; what the risk manager blocked.

import * as D from '../desk.js';
import { esc, p1, panel, gauge, bars, TIER_LABEL } from '../ui.js';

const SECTORS = ['Tech', 'Health', 'Financials', 'Energy', 'Retail', 'Auto', 'Telecom', 'Media'];

// Percent fields are edited as whole percents; money fields as dollars.
export const LIMIT_FIELDS = [
  { key: 'maxPositionPct', label: 'Max single stock position', unit: '%', hint: 'Largest share of NAV any one stock may reach after a buy.' },
  { key: 'maxEtfPct', label: 'Max single ETF position', unit: '%', hint: 'Largest share of NAV any one fund (ETF) may reach after a buy. Funds are diversified, so this is higher than the stock cap.' },
  { key: 'maxCryptoPct', label: 'Max crypto, combined', unit: '%', hint: 'All coins together, as a share of NAV.' },
  { key: 'minCashPct', label: 'Cash floor', unit: '%', hint: 'Buys that would leave less cash than this are blocked.' },
  { key: 'dailyLossLimitPct', label: 'Daily loss limit', unit: '%', neg: true, hint: 'Once the day is down this much, new buys stop. Sells still allowed.' },
  { key: 'maxDrawdownPct', label: 'Max drawdown from peak', unit: '%', hint: 'Once NAV is this far below its peak, new buys stop.' },
  { key: 'maxOrderValue', label: 'Max order size', unit: '$', hint: 'No single order above this, approved or not.' },
  { key: 'autoMaxOrderValue', label: 'Auto-trade size cap', unit: '$', hint: 'Auto mode only fills orders at or under this. Larger ones wait for you.' },
  { key: 'minOrderValue', label: 'Minimum buy', unit: '$', hint: 'Buys smaller than this are blocked, and quants won\'t propose them.' }
];

const toInput = (f, v) => (v == null ? '' : f.unit === '%' ? String(+(Math.abs(v) * 100).toFixed(2)) : String(v));
export function fromInput(f, raw) {
  if (raw === '' || raw == null) return { error: `${f.label}: enter a value` };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { error: `${f.label}: must be a number of 0 or more` };
  if (f.unit === '%') { if (n > 100) return { error: `${f.label}: must be 100% or less` }; return { value: (f.neg ? -1 : 1) * n / 100 }; }
  return { value: n };
}

export function renderRisk(s, ui) {
  const L = s.settings.limits, d = ui.drafts, t = D.totals(s), DEF = D.defaultLimitsFor(s.fund.capital);
  const val = (id, fallback) => (d[id] ?? fallback);
  const fields = LIMIT_FIELDS.map(f => `<div class="field">
      <label for="lim-${f.key}">${f.label}</label>
      <input id="lim-${f.key}" data-draft inputmode="decimal" value="${esc(val('lim-' + f.key, toInput(f, L[f.key])))}" aria-describedby="hint-${f.key}">
      <span class="hint" id="hint-${f.key}">${f.unit === '%' ? 'Percent. ' : 'Dollars. '}${f.hint} Default ${f.unit === '$' ? '$' : ''}${toInput(f, DEF[f.key])}${f.unit === '%' ? '%' : ''}.</span></div>`).join('');
  const sectorFields = SECTORS.map(sec => `<div class="field">
      <label for="sec-${sec}">${sec} cap</label>
      <input id="sec-${sec}" data-draft inputmode="decimal" placeholder="no cap" value="${esc(val('sec-' + sec, L.sectorLimits?.[sec] != null ? String(+(L.sectorLimits[sec] * 100).toFixed(2)) : ''))}"></div>`).join('');
  const tiers = Object.keys(TIER_LABEL).map(tier => {
    const id = 'tier-' + tier;
    const on = d[id] != null ? d[id] === 'true' : L.autoTiers.includes(tier);
    return `<label><input type="checkbox" id="${id}" data-draft ${on ? 'checked' : ''}> ${TIER_LABEL[tier]}</label>`;
  }).join('');
  const dirty = Object.keys(d).some(k => /^(lim|sec|tier)-/.test(k));

  const snap = D.snapshot(s);
  const day = t.equity / s.startOfDayEquity - 1;
  const exposure = gauge('Daily loss', Math.max(0, -day), -L.dailyLossLimitPct, p1) +
    gauge('Drawdown from peak', Math.max(0, 1 - t.equity / s.peakEquity), L.maxDrawdownPct, p1, `Peak NAV ${D.usd(s.peakEquity)}`) +
    (lg => gauge('Largest position vs its cap', lg ? lg.weight : 0, lg ? lg.cap : L.maxPositionPct, p1, lg ? lg.sym : 'No positions'))(D.largestVsCap(s)) +
    gauge('Crypto', t.crypto / t.equity, L.maxCryptoPct, p1) +
    gauge('Day trades (5 days)', D.dayTradesUsed(s), L.dayTradeLimit ?? 0, v => String(v), t.equity >= L.dayTradeEquityThreshold ? `Cap does not apply above ${D.usd(L.dayTradeEquityThreshold)} NAV.` : '');
  const sectorBars = bars(Object.entries(t.bySector).map(([label, value]) => ({ label, value, cap: L.sectorLimits?.[label] })).sort((a, b) => b.value - a.value), t.equity, v => D.usd(v));

  const vetoes = s.log.filter(e => e.kind === 'veto' || /^Risk limits/.test(e.text)).slice(0, 40);
  const history = vetoes.length ? `<ul class="log">${vetoes.map(e => `<li><time>${e.at}</time><span class="tag ${e.kind}">${e.kind === 'veto' ? 'blocked' : 'change'}</span><span>${esc(e.text)}</span></li>`).join('')}</ul>`
    : '<div class="empty">Nothing blocked or changed yet.</div>';

  return `<div class="desk-head"><h1>Risk</h1><p>You set the limits; the risk manager enforces them on every order, yours included. Changes apply immediately and are written to the audit log.</p></div>
    <div class="cols-2">
      ${panel('Limits', dirty ? 'unsaved changes' : 'saved', `<div class="form">${fields}
        <div class="field"><label>Quant tiers allowed to auto-trade</label><span></span><div class="hint checkrow">${tiers}</div>
          <span class="hint">Auto mode only fills orders from quants with these ratings. "Unproven" lets quants trade alone before they have a record.</span></div>
        <h3 class="muted" style="margin:6px 0 0;font-size:12px;letter-spacing:.08em;text-transform:uppercase">Sector caps (percent of NAV, blank = no cap)</h3>
        ${sectorFields}
        ${ui.formError ? `<div class="down" role="alert">${esc(ui.formError)}</div>` : ''}
        <div class="actions"><button class="btn primary" data-act="saveLimits">Save limits</button>
          <button class="btn" data-act="discardLimits" ${dirty ? '' : 'disabled'}>Discard changes</button>
          <button class="btn ghost" data-act="resetLimits">Reset to defaults</button></div></div>`)}
      <div style="display:grid;gap:12px">
        ${panel('Live exposure', '', exposure)}
        ${panel('Sector exposure', 'marks show caps', sectorBars)}
        ${panel('Blocked orders and limit changes', `${vetoes.length}`, history)}
      </div>
    </div>`;
}

export { SECTORS };
