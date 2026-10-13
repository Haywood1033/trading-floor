// Append-only audit trail: every signal, veto, approval, fill and halt gets one entry.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function memoryLog() {
  const entries = [];
  return { entries, append: e => { entries.push(e); } };
}

export function fileLog(path) {
  mkdirSync(dirname(path), { recursive: true });
  return { append: e => appendFileSync(path, JSON.stringify(e) + '\n') };
}

export function record(log, kind, data, now = new Date()) {
  const entry = { at: now.toISOString(), kind, ...data };
  log.append(entry);
  return entry;
}
