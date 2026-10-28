import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../app/desk.js';
import { TICKS_PER_DAY } from '../app/sim.js';

const fresh = () => D.freshState({ seed: 11, capital: 100000 });

test('the first open queues momentum buys on a cash-only fund', () => {
  const s = fresh();
  D.openDay(s);
  const p = D.pending(s);
  assert.ok(p.length >= 3);
  assert.ok(p.every(o => o.quantId === 'mom' && o.side === 'buy'));
  assert.equal(s.signals.length, p.length);       // every call recorded for grading
  D.openDay(s);                                     // idempotent within a day
  assert.equal(D.pending(s).length, p.length);
});

test('approving fills at the current price and moves cash into the position', () => {
  const s = fresh(); D.openDay(s);
  const o = D.pending(s)[0];
  const price = s.sim.prices[o.symbol];
  assert.equal(D.approve(s, o.id).ok, true);
  assert.equal(o.status, 'filled');
  assert.ok(Math.abs(s.account.cash - (100000 - o.qty * price)) < 1e-6);
  assert.equal(s.account.positions[o.symbol].qty, o.qty);
  assert.ok(Math.abs(D.totals(s).equity - 100000) < 1e-6);
});

test('risk vetoes stop a fill and leave the order pending', () => {
  const s = fresh(); D.openDay(s);
  const o = D.pending(s)[0];
  D.setQty(s, o.id, Math.ceil(30000 / s.sim.prices[o.symbol])); // ~30% of the fund
  const r = D.approve(s, o.id);
  assert.equal(r.ok, false);
  assert.equal(o.status, 'pending');
  assert.equal(Object.keys(s.account.positions).length, 0);
  D.resizeToFit(s, o.id);
  assert.equal(D.approve(s, o.id).ok, true);
});

test('kill switch cancels the queue and blocks fills until resumed', () => {
  const s = fresh(); D.openDay(s);
  const ids = D.pending(s).map(o => o.id);
  D.halt(s);
  assert.equal(D.pending(s).length, 0);
  assert.ok(ids.every(id => s.orders.find(o => o.id === id).status === 'cancelled'));
  D.skipToClose(s);                                   // next open runs no quants while halted
  assert.equal(D.pending(s).length, 0);
  D.resume(s);
  assert.equal(s.kill.halted, false);
});

test('unapproved orders expire at the close and the next day opens with new proposals', () => {
  const s = fresh(); D.openDay(s);
  const first = D.pending(s).map(o => o.id);
  const day = s.sim.day;
  D.skipToClose(s);
  assert.notEqual(s.sim.day, day);
  assert.ok(first.every(id => s.orders.find(o => o.id === id).status === 'expired'));
  assert.ok(D.pending(s).length > 0);
  assert.equal(s.curve.daily.length, 1);
});

test('auto mode fills nothing while every quant is unproven', () => {
  const s = fresh(); D.openDay(s);
  D.setMode(s, 'auto');
  assert.ok(D.pending(s).length > 0);
  assert.ok(D.pending(s).every(o => !D.riskFor(s, o).auto.auto));
});

test('auto mode fills small orders from a proven quant', () => {
  const s = fresh(); D.openDay(s);
  s.settings.limits.autoTiers = ['elite', 'allstar', 'value', 'unproven']; // manager widens auto (Risk desk later)
  s.settings.limits.autoMaxOrderValue = 6000;                                // momentum sizes ~$5k per buy
  D.setMode(s, 'auto');
  const filled = s.orders.filter(o => o.status === 'filled' && o.approvedBy === 'auto');
  assert.ok(filled.length > 0);
  assert.ok(filled.every(o => o.fillPrice * o.qty <= s.settings.limits.autoMaxOrderValue));
});

test('paper and off modes', () => {
  const s = fresh();
  D.setQuantMode(s, 'mom', 'paper');
  D.openDay(s);
  assert.equal(D.pending(s).length, 0);
  assert.ok(s.signals.length > 0);
  const t = fresh(); D.setQuantMode(t, 'mom', 'off'); D.openDay(t);
  assert.equal(t.signals.length, 0);
});

test('sells realize P&L against cost basis, and calls get graded after 63 days', () => {
  const s = fresh(); D.openDay(s);
  const o = D.pending(s)[0];
  D.approve(s, o.id);
  for (let d = 0; d < 64; d++) D.skipToClose(s);
  assert.ok(s.signals.some(x => x.status === 'graded'));
  const sb = D.scoreboard(s).find(q => q.id === 'mom');
  assert.ok(sb.graded > 0);
  // sell the position through the same path
  s.orders.unshift({ id: s.seq++, status: 'pending', quantId: 'rev', symbol: o.symbol, side: 'sell', qty: s.account.positions[o.symbol].qty, sector: o.sector, assetClass: 'stock' });
  const before = s.account.realized;
  assert.equal(D.approve(s, s.orders[0].id).ok, true);
  assert.notEqual(s.account.realized, before);
  assert.equal(s.account.positions[o.symbol], undefined);
});

test('state survives JSON (localStorage) and keeps ticking', () => {
  const s = fresh(); D.openDay(s);
  for (let i = 0; i < 10; i++) D.tick(s);
  const t = JSON.parse(JSON.stringify(s));
  for (let i = 0; i < TICKS_PER_DAY; i++) D.tick(t);
  assert.notEqual(t.sim.day, s.sim.day);
});

test('manager tickets fill through the same risk checks', () => {
  const s = fresh(); D.openDay(s);
  assert.equal(D.placeManual(s, { symbol: 'JPM', side: 'buy', qty: 10 }).ok, true);
  assert.equal(s.account.positions.JPM.openedBy, 'manager');
  const big = D.placeManual(s, { symbol: 'JPM', side: 'buy', qty: 1000 });
  assert.equal(big.ok, false);
  assert.match(big.reason, /JPM|Order value/);
  assert.equal(D.placeManual(s, { symbol: 'XOM', side: 'sell', qty: 1 }).ok, false);   // nothing to sell
  assert.equal(D.closePosition(s, 'JPM').ok, true);
  assert.equal(s.account.positions.JPM, undefined);
  const sale = s.orders.find(o => o.side === 'sell' && o.symbol === 'JPM');
  assert.equal(sale.attribution, 'manager');
  assert.equal(typeof sale.realized, 'number');
});

test('quant capital cap blocks buys beyond its share of the fund', () => {
  const s = fresh(); D.openDay(s);
  D.setQuantAlloc(s, 'mom', 0.06);
  const [a, b] = D.pending(s);
  assert.equal(D.approve(s, a.id).ok, true);            // ~5% fits under 6%
  const r = D.riskFor(s, b);
  assert.equal(r.approved, false);
  assert.ok(r.checks.some(c => c.id === 'quantAllocation' && !c.ok));
  assert.ok(r.fit >= 0 && r.fit < b.qty);
});

test('changing limits is logged and takes effect', () => {
  const s = fresh(); D.openDay(s);
  const o = D.pending(s)[0];
  assert.equal(D.updateLimits(s, { maxOrderValue: 1000 }), 1);
  assert.match(s.log[0].text, /maxOrderValue 20000 → 1000/);
  assert.equal(D.riskFor(s, o).approved, false);
  D.resetLimits(s);
  assert.equal(D.riskFor(s, o).approved, true);
});

test('auto rules set by the manager let auto mode trade', () => {
  const s = fresh(); D.openDay(s);
  D.setMode(s, 'auto');
  assert.equal(s.orders.filter(o => o.approvedBy === 'auto').length, 0);
  D.updateLimits(s, { autoTiers: ['elite', 'allstar', 'value', 'unproven'], autoMaxOrderValue: 5000 });
  assert.ok(s.orders.filter(o => o.approvedBy === 'auto').length > 0);
});

test('day trades and wash sales are tracked', () => {
  const s = fresh(); D.openDay(s);
  D.placeManual(s, { symbol: 'JPM', side: 'buy', qty: 10 });
  assert.equal(D.dayTradesUsed(s), 0);
  D.placeManual(s, { symbol: 'JPM', side: 'sell', qty: 10 });
  assert.deepEqual(D.dayTradeLog(s).map(d => d.symbol), ['JPM']);
  // force a loss sale then a rebuy
  D.placeManual(s, { symbol: 'XOM', side: 'buy', qty: 10 });
  s.account.positions.XOM.costBasis *= 2;
  D.placeManual(s, { symbol: 'XOM', side: 'sell', qty: 10 });
  D.placeManual(s, { symbol: 'XOM', side: 'buy', qty: 5 });
  const w = D.washSaleWatch(s).find(x => x.symbol === 'XOM');
  assert.ok(w && w.loss < 0 && w.rebought);
});

test('peak NAV is tracked and old saved funds migrate', () => {
  const s = fresh(); D.openDay(s);
  for (let i = 0; i < 20; i++) D.tick(s);
  assert.ok(s.peakEquity >= 100000);
  const old = JSON.parse(JSON.stringify(s));
  delete old.peakEquity; delete old.settings.quantAlloc; delete old.fund.spyStart; delete old.settings.limits.maxDrawdownPct;
  D.migrate(old);
  assert.ok(old.peakEquity >= 100000 && old.settings.quantAlloc.mom === 0.6 && old.fund.spyStart > 0 && old.settings.limits.maxDrawdownPct === 0.15);
});

test('a $1,000 fund trades fractional shares with limits scaled to its size', () => {
  const s = D.freshState({ seed: 11 });
  assert.equal(s.fund.capital, 1000);
  const L = s.settings.limits;
  assert.deepEqual([L.maxOrderValue, L.autoMaxOrderValue, L.minOrderValue], [200, 100, 5]);
  D.openDay(s);
  const p = D.pending(s);
  assert.ok(p.length >= 3, 'momentum still proposes on a small fund');
  assert.ok(p.some(o => !Number.isInteger(o.qty)), 'fractional sizes');
  assert.ok(p.every(o => o.qty * s.sim.prices[o.symbol] <= 50.01));
  assert.equal(D.approve(s, p[0].id).ok, true);
  assert.ok(D.totals(s).equity > 999 && D.totals(s).equity < 1001);
  // the minimum order applies to buys
  assert.equal(D.placeManual(s, { symbol: 'NVDA', side: 'buy', qty: 0.01 }).ok, false);
  // +/- moves about 1% of the fund
  const o = p[1];
  assert.ok(Math.abs(D.nudge(s, o) * s.sim.prices[o.symbol] - 10) < 2);
  D.resetLimits(s);
  assert.equal(s.settings.limits.maxOrderValue, 200);
});

// ---- replay funds on real-shaped history
import { synthHist } from './helpers.js';
function replayFund() {
  const syms = { SPY: 0.0004, QQQ: 0.0009, XLK: 0.0011, XLE: -0.0004, TLT: 0.0001, GLD: 0.0006, SHY: 0.00005, BTC: 0.002 };
  const h = synthHist(600, syms);
  D.setMarket(h);
  return { h, s: D.freshReplayState({ startDate: h.dates[300], capital: 1000 }) };
}

test('a replay fund starts on the chosen real date with rotation buys of about a third each', () => {
  const { h, s } = replayFund();
  assert.equal(s.sim.day, h.dates[300]);
  D.openDay(s);
  const p = D.pending(s);
  assert.ok(p.length >= 2 && p.length <= 3);
  assert.ok(p.every(o => o.quantId === 'mom' && o.side === 'buy' && o.assetClass === 'etf'));
  for (const o of p) assert.equal(D.approve(s, o.id).ok, true, `${o.symbol}: ${JSON.stringify(D.riskFor(s, o).checks.filter(c => !c.ok))}`);
  assert.ok(D.totals(s).cash / D.totals(s).equity > 0.05);
});

test('the rotation only rebalances every 21 trading days', () => {
  const { s } = replayFund();
  D.openDay(s);
  for (const o of D.pending(s)) D.approve(s, o.id);
  D.skipToClose(s);                                        // day 2
  assert.equal(D.pending(s).filter(o => o.quantId === 'mom').length, 0);
  assert.equal(D.daysToRebalance(s), 20);
  D.skipDays(s, 20);
  assert.ok(s.log.some(e => /Momentum/.test(e.text) && e.at.startsWith(s.sim.day)));
});

test('skipping ahead stops at the open where new proposals are waiting', () => {
  const { s } = replayFund();
  D.openDay(s);
  for (const o of D.pending(s)) D.reject(s, o.id);
  const ran = D.skipDays(s, 60);
  assert.ok(ran <= 21, `ran ${ran} days`);
  assert.ok(D.pending(s).length > 0, 'stopped with the rebalance proposals still open');
  assert.equal(s.sim.tick, 0, 'at the market open');
});

test('a replay fund saves small, reloads, and replays the same market', () => {
  const { s } = replayFund();
  D.openDay(s);
  for (let i = 0; i < 10; i++) D.tick(s);
  const json = JSON.stringify(s);
  assert.ok(json.length < 60000, `saved size ${json.length}`);
  const t = D.migrate(JSON.parse(json));
  D.tick(s); D.tick(t);
  assert.deepEqual(t.sim.prices, s.sim.prices);
});

test('a replay fund ends cleanly when the history runs out', () => {
  const { h } = replayFund();
  const s = D.freshReplayState({ startDate: h.dates[595], capital: 1000 });
  D.skipDays(s, 10);
  assert.equal(s.sim.ended, true);
  assert.equal(D.marketOpen(s), false);
  assert.ok(s.log.some(e => /latest data/.test(e.text)));
});

test('ETF holdings are measured against the ETF cap on screen too', () => {
  const { s } = replayFund();
  D.openDay(s);
  for (const o of D.pending(s)) D.approve(s, o.id);
  const lg = D.largestVsCap(s);
  assert.equal(lg.cap, s.settings.limits.maxEtfPct);
  assert.ok(lg.weight < lg.cap);
  const anyEtf = Object.values(s.account.positions)[0];
  assert.equal(D.positionCap(s, anyEtf), 0.35);
  assert.equal(D.positionCap(s, { assetClass: 'stock' }), 0.10);
  assert.equal(D.positionCap(s, { assetClass: 'crypto' }), null);
});
