// Shared HTML builders for every desk.

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const cls = v => (v > 1e-9 ? 'up' : v < -1e-9 ? 'down' : 'muted');
export const p1 = v => (v * 100).toFixed(1) + '%';
export const signed = (v, f) => (v > 0 ? '+' : '') + f(v);
export const TIER_LABEL = { elite: 'Elite', allstar: 'All-Star', value: 'Value', unproven: 'Unproven' };
export const tierChip = t => `<span class="tier ${t}">${TIER_LABEL[t]}</span>`;

export function panel(title, sub, body, extraClass = '') {
  return `<section class="panel ${extraClass}"><h2>${title}${sub ? ` <small>${sub}</small>` : ''}</h2>${body}</section>`;
}

export function gauge(label, cur, limit, fmt, note) {
  const ratio = limit ? cur / limit : 0;
  const lvl = ratio >= 1 ? 'bad' : ratio >= 0.85 ? 'warn' : '';
  return `<div class="gauge"><div class="gtop"><span>${label}</span><span class="num">${fmt(cur)} / ${fmt(limit)}</span></div>
    <div class="track"><div class="gfill ${lvl}" style="width:${Math.max(0, Math.min(1, ratio)) * 100}%"></div></div>${note ? `<div class="gnote">${note}</div>` : ''}</div>`;
}

// Horizontal bars for allocation breakdowns: rows = [{ label, value, cap? }]
export function bars(rows, total, fmtVal) {
  if (!rows.length) return '<div class="empty">Nothing to show yet.</div>';
  return `<div class="bars">${rows.map(r => {
    const w = total ? r.value / total : 0;
    const over = r.cap != null && w > r.cap;
    return `<div class="barrow"><span>${esc(r.label)}</span>
      <div class="track"><div class="gfill ${over ? 'bad' : ''}" style="width:${Math.min(1, w) * 100}%"></div>${r.cap != null ? `<i class="capmark" style="left:${Math.min(1, r.cap) * 100}%" title="cap"></i>` : ''}</div>
      <span class="num">${p1(w)}${r.cap != null ? ` <span class="muted">/ ${p1(r.cap)}</span>` : ''}</span><span class="num muted">${fmtVal(r.value)}</span></div>`;
  }).join('')}</div>`;
}

// Line chart of one or more series sharing an x axis. series = [{ name, values, color, dash? }]
// Lines are drawn in a stretched SVG; labels are HTML so text stays readable at any width.
export function lineChart(series, labels, { fmtY = v => v.toFixed(0) } = {}) {
  const n = Math.max(...series.map(s => s.values.length));
  if (n < 2) return '<div class="empty">The chart fills in as simulated days close.</div>';
  const W = 1000, H = 200;
  const all = series.flatMap(s => s.values).filter(v => v != null);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = i => i / (n - 1) * W;
  const y = v => (1 - (v - lo) / (hi - lo)) * H;
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const grid = ticks.map(v => `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('');
  const lines = series.map(s => {
    const d = s.values.map((v, i) => (v == null ? '' : `${i && s.values[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" vector-effect="non-scaling-stroke" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>`;
  }).join('');
  const yl = ticks.map(v => `<span style="top:${(y(v) / H * 100).toFixed(2)}%">${esc(fmtY(v))}</span>`).join('');
  const legend = series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  return `<div class="chart"><div class="yaxis">${yl}</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(series.map(s => s.name).join(' vs '))}">${grid}${lines}</svg>
    <div class="xaxis"><span>${esc(labels[0] || '')}</span><span>${esc(labels[1] || '')}</span></div>
    <div class="legend">${legend}</div></div>`;
}

export function seg(act, current, options, extra = '') {
  return `<div class="seg small" role="group">${options.map(([v, label]) =>
    `<button data-act="${act}" data-v="${v}" ${extra} aria-pressed="${String(v) === String(current)}">${label}</button>`).join('')}</div>`;
}
