// Append-only audit trail: every signal, veto, approval, fill and halt gets one entry.


export function memoryLog() {
  const entries = [];
  return { entries, append: e => { entries.push(e); } };
}


export function record(log, kind, data, now = new Date()) {
  const entry = { at: now.toISOString(), kind, ...data };
  log.append(entry);
  return entry;
}
