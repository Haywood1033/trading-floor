// Accuracy tracking. Every proposal a quant makes is recorded as a signal, whether or not
// it was traded, and graded once its horizon has passed.
//
// A call is graded against a benchmark, not in absolute terms:
//   buy  is right if the stock beat the benchmark over the horizon
//   sell is right if the stock trailed the benchmark (selling avoided underperformance)
// "excess" is that relative return, signed so positive always means the call was right.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { tierFor, wilsonLower } from './stats.js';

export function memorySignalStore(initial = []) {
  let rows = structuredClone(initial);
  return { load: () => rows, save: r => { rows = r; } };
}

export function fileSignalStore(path) {
  return {
    load() { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; } },
    save(rows) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(rows, null, 2)); }
  };
}

const today = () => new Date().toISOString().slice(0, 10);

export function createTracker(store) {
  return {
    all: () => store.load(),

    // Records a proposal as an open signal. Skips it if the same quant already has an open
    // call on the same symbol and side, so a daily run doesn't stack duplicates.
    record(p, { benchmark, benchEntry, issuedOn = today(), horizonDays = 63 }) {
      const rows = store.load();
      const dup = rows.find(r => r.status === 'open' && r.quantId === p.quantId && r.symbol === p.symbol && r.side === p.side);
      if (dup) return { recorded: false, signal: dup };
      const signal = {
        id: `${p.quantId}-${p.symbol}-${p.side}-${issuedOn}`,
        quantId: p.quantId, symbol: p.symbol, side: p.side, assetClass: p.assetClass,
        confidence: p.confidence, thesis: p.thesis,
        issuedOn, horizonDays, entryPrice: p.price, benchmark, benchEntry,
        status: 'open', result: null
      };
      rows.push(signal);
      store.save(rows);
      return { recorded: true, signal };
    },

    // closesAfter(symbol, date) -> closes for trading days strictly after `date`, oldest first.
    async gradeOpen(closesAfter) {
      const rows = store.load();
      const graded = [];
      for (const s of rows) {
        if (s.status !== 'open') continue;
        const [px, bx] = await Promise.all([closesAfter(s.symbol, s.issuedOn), closesAfter(s.benchmark, s.issuedOn)]);
        const result = gradeSignal(s, px, bx);
        if (!result) continue;
        s.status = 'graded';
        s.result = result;
        graded.push(s);
      }
      store.save(rows);
      return graded;
    },

    scoreboard() {
      const byQuant = {};
      for (const s of store.load()) {
        const q = byQuant[s.quantId] ||= { quantId: s.quantId, open: 0, n: 0, hits: 0, excessSum: 0 };
        if (s.status === 'open') { q.open++; continue; }
        q.n++;
        if (s.result.correct) q.hits++;
        q.excessSum += s.result.excess;
      }
      return Object.values(byQuant).map(q => {
        const avgExcess = q.n ? q.excessSum / q.n : 0;
        return {
          quantId: q.quantId, open: q.open, graded: q.n, hits: q.hits,
          hitRate: q.n ? q.hits / q.n : null,
          lowerBound: wilsonLower(q.hits, q.n),
          avgExcess,
          tier: tierFor({ n: q.n, hits: q.hits, avgExcess })
        };
      });
    }
  };
}

// Pure. Returns null until `horizonDays` trading days have closed after the call.
export function gradeSignal(s, closes, benchCloses) {
  if (!closes || !benchCloses || closes.length < s.horizonDays || benchCloses.length < s.horizonDays) return null;
  const exit = closes[s.horizonDays - 1];
  const benchExit = benchCloses[s.horizonDays - 1];
  const ret = exit / s.entryPrice - 1;
  const benchRet = benchExit / s.benchEntry - 1;
  const sign = s.side === 'buy' ? 1 : -1;
  const excess = sign * (ret - benchRet);
  return { exitPrice: exit, ret, benchRet, excess, correct: excess > 0 };
}
