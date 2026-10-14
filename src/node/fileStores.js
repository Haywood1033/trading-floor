// File-backed stores for Node scripts. Kept out of the engine modules so the engine also
// runs in the browser app.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function fileSignalStore(path) {
  return {
    load() { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; } },
    save(rows) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(rows, null, 2)); }
  };
}

// Kill switch state.
export function fileStore(path) {
  return {
    read() { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } },
    write(v) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(v, null, 2)); }
  };
}

// Append-only audit log.
export function fileLog(path) {
  mkdirSync(dirname(path), { recursive: true });
  return { append: e => appendFileSync(path, JSON.stringify(e) + '\n') };
}
