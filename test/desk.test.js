import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../app/desk.js';
import { synthHist, rotatingMarket } from './helpers.js';
import { simulate, momentumRotation } from '../src/portfolioBacktest.js';
import { ROTATION_UNIVERSE } from '../src/data/universe.js';

const SYMS = { SPY: 0.0004, QQQ: 0.0009, XLK: 0.0011, XLE: -0.0004, TLT: 0.0001, GLD: 0.0006, SHY: 0.00005, BTC: 0.002 };
function fund({ capital = 1000, start = 300, hist } = {}) {
  const h = hist || synthHist(600, SYMS);
  D.setMarket(h);
  const s = D.freshReplayState({ startDate: h.dates[start], capital });
  D.decide(s);
  return { h, s };
}
const approveAll = s => { for (const o of D.pending(s)) D.approve(s, o.id); };

test('a new fund decides at the close of its start date: rotation buys a third of its sleeve each', () => {
  const { h, s } = fund();
  assert.equal(s.sim.day, h.dates[300]);
  const rot = D.pending(s).filter(o => o.quantId === 'mom');
  assert.ok(rot.length >= 2 && rot.length <= 3);
  for (const o of rot) assert.ok(Math.abs(o.qty * s.sim.prices[o.symbol] - 200) < 2, 'a third of the 60% sleeve');
  D.decide(s);                                                   // once per day
  assert.equal(D.pending(s).filter(o => o.quantId === 'mom').length, rot.length);
});

test('approved orders fill at the NEXT close and pay trading costs', () => {
  const { h, s } = fund();
  const o = D.pending(s).find(x => x.quantId === 'mom');
  assert.equal(D.approve(s, o.id).ok, true);
  assert.equal(o.status, 'approved');
  assert.equal(s.account.cash, 1000, 'nothing moves at approval');
  D.advance(s);
  assert.equal(o.status, 'filled');
  const px = h.closes[o.symbol][301];
  assert.equal(o.fillPrice, px);
  const fee = o.qty * px * 10 / 1e4;
  assert.ok(Math.abs(o.fee - fee) < 1e-9);
  assert.ok(Math.abs(s.account.cash - (1000 - o.qty * px - fee)) < 1e-9);
  assert.ok(Math.abs(s.account.fees - fee) < 1e-9);
});

test('risk is checked again at the fill: an order that no longer passes is blocked, not filled', () => {
  const { s } = fund();
  const o = D.pending(s).find(x => x.side === 'buy');
  D.approve(s, o.id);
  D.updateLimits(s, { maxOrderPct: 0.01 });
  D.advance(s);
  assert.equal(o.status, 'blocked');
  assert.match(o.blockedReason, /Order \$/);
  assert.equal(Object.keys(s.account.positions).length, 0);
});

test('order size scales with the fund, and selling is never blocked by size', () => {
  const { s } = fund({ capital: 10000 });
  approveAll(s); D.advance(s);
  const sym = Object.keys(s.account.positions)[0];
  D.updateLimits(s, { maxOrderPct: 0.01 });
  assert.equal(D.closePosition(s, sym).ok, true, 'closing a position ignores the size cap');
  const small = D.previewManual(s, { symbol: 'GLD', side: 'buy', qty: 0.5 });
  const big = D.previewManual(s, { symbol: 'GLD', side: 'buy', qty: 5 });
  assert.equal(small.checks.find(c => c.id === 'maxOrderValue').ok, true);
  assert.equal(big.checks.find(c => c.id === 'maxOrderValue').ok, false);
  assert.match(big.checks.find(c => c.id === 'maxOrderValue').message, /max \$1\d\d/);  // 1% of ~$10k
});

test('the drawdown breaker pauses buys, then re-arms instead of locking the fund in cash', () => {
  const h = synthHist(700, SYMS);
  for (const s of Object.keys(h.closes)) for (let i = 320; i < 700; i++) {
    const f = i < 340 ? 0.985 : 1.003;                          // a 26% slide, then a recovery
    h.closes[s][i] = +(h.closes[s][i - 1] * f).toFixed(4);
  }
  const { s } = fund({ hist: h, capital: 10000 });
  D.setMode(s, 'auto');
  D.updateLimits(s, { autoTiers: ['elite', 'allstar', 'value', 'unproven'], autoMaxOrderPct: 1 });
  let tripped = null, rearmed = null;
  for (let d = 0; d < 120; d++) {
    D.advance(s);
    if (s.breaker && !tripped) tripped = s.daysRun;
    if (tripped && !s.breaker && !rearmed) rearmed = s.daysRun;
  }
  assert.ok(tripped, 'tripped during the slide');
  assert.equal(rearmed - tripped, 21, 'paused 21 trading days, then re-armed');
  assert.ok(s.log.some(e => /Drawdown breaker tripped/.test(e.text)) && s.log.some(e => /re-armed/.test(e.text)));
  const lastBuy = s.orders.filter(o => o.status === 'filled' && o.side === 'buy').at(-1);
  assert.ok(lastBuy.filledAt > h.dates[300 + rearmed], 'buys resumed after it re-armed');
});

test('the manager can re-arm the breaker by hand', () => {
  const { s } = fund();
  s.breaker = { trippedOn: s.sim.day, until: s.daysRun + 21, untilDate: 'later', peak: 2000 };
  assert.equal(D.previewManual(s, { symbol: 'GLD', side: 'buy', qty: 0.5 }).checks.find(c => c.id === 'drawdown').ok, false);
  D.rearmBreaker(s);
  assert.equal(s.breaker, null);
  assert.equal(D.previewManual(s, { symbol: 'GLD', side: 'buy', qty: 0.5 }).approved, true);
});

test('an unanswered rebalance is retried at the next close; a rejected one waits a month', () => {
  const a = fund().s;
  assert.ok(D.pending(a).some(o => o.quantId === 'mom'));
  D.advance(a);                                                   // nobody answered
  assert.ok(D.pending(a).some(o => o.quantId === 'mom'), 'proposed again the next day');
  const b = fund().s;
  for (const o of D.pending(b)) if (o.quantId === 'mom') D.reject(b, o.id);
  D.advance(b);
  assert.equal(D.pending(b).filter(o => o.quantId === 'mom').length, 0);
  assert.equal(D.daysToRebalance(b), 20);
});

test('skipping ahead stops at the first close where proposals are waiting', () => {
  const { s } = fund({ hist: rotatingMarket(900), capital: 10000 });
  approveAll(s);
  const ran = D.skipDays(s, 200);
  assert.ok(ran >= 1 && ran < 200, `ran ${ran}`);
  assert.ok(D.pending(s).length > 0);
  approveAll(s);
  const quiet = fund().s;                                         // a calm market: nothing to decide
  approveAll(quiet);
  assert.equal(D.skipDays(quiet, 10), 10);
});

test('the kill switch cancels waiting and approved orders and stops the quants', () => {
  const { s } = fund();
  const [a, b] = D.pending(s);
  D.approve(s, a.id);
  D.halt(s);
  assert.equal(a.status, 'cancelled'); assert.equal(b.status, 'cancelled');
  D.advance(s);
  assert.equal(D.pending(s).length, 0);
  assert.equal(Object.keys(s.account.positions).length, 0);
  D.resume(s);
  assert.equal(s.kill.halted, false);
});

test('auto mode approves only what its rules allow', () => {
  const { s } = fund();
  D.setMode(s, 'auto');
  assert.equal(D.approved(s).length, 0, 'every quant is unproven');
  D.updateLimits(s, { autoTiers: ['elite', 'allstar', 'value', 'unproven'], autoMaxOrderPct: 0.25 });
  assert.ok(D.approved(s).length > 0);
  assert.ok(D.approved(s).every(o => o.approvedBy === 'auto'));
});

test('mean reversion on paper records calls without queuing, and keeps a paper book', () => {
  const h = synthHist(600, { SPY: 0.0004, XLK: 0.0011, TLT: 0.0001, SHY: 0.00005 });
  for (const i of [299, 300]) h.closes.XLK[i] = +(h.closes.XLK[i - 1] * 0.975).toFixed(4);
  const { s } = fund({ hist: h });
  assert.equal(D.pending(s).filter(o => o.quantId === 'mr').length, 0);
  const call = s.signals.find(x => x.quantId === 'mr');
  assert.ok(call && call.symbol === 'XLK' && call.horizonDays === 10);
  assert.ok('XLK' in s.paperBook.mr);
});

test('crypto trend buys into its sleeve and checks weekly', () => {
  const { s } = fund();
  const c = D.pending(s).filter(o => o.quantId === 'cry');
  assert.deepEqual(c.map(o => o.symbol), ['BTC']);
  assert.ok(Math.abs(c[0].qty * s.sim.prices.BTC - 150) < 1);
  D.approve(s, c[0].id); D.advance(s);
  assert.equal(s.account.positions.BTC.openedBy, 'cry');
  assert.equal(D.pending(s).filter(o => o.quantId === 'cry').length, 0);
});

test('two quants can own parts of the same fund, and each sells only its own', () => {
  const h = synthHist(600, { SPY: 0.0004, XLK: 0.0011, TLT: 0.0001, SHY: 0.00005 });
  for (const i of [299, 300]) h.closes.XLK[i] = +(h.closes.XLK[i - 1] * 0.975).toFixed(4);
  D.setMarket(h);
  const s = D.freshReplayState({ startDate: h.dates[300], capital: 1000 });
  D.setQuantMode(s, 'mr', 'live');
  D.decide(s);
  const xlk = D.pending(s).filter(o => o.symbol === 'XLK');
  assert.deepEqual(xlk.map(o => o.quantId).sort(), ['mom', 'mr']);
  for (const o of xlk) D.approve(s, o.id);
  D.advance(s);
  const owners = D.ownersOf(s.account.positions.XLK);
  assert.ok(owners.mom > 0 && owners.mr > 0);
  s.orders.push({ id: s.seq++, status: 'pending', quantId: 'mr', symbol: 'XLK', side: 'sell', qty: owners.mr, sector: 'Tech', assetClass: 'etf' });
  D.approve(s, s.orders.at(-1).id); D.advance(s);
  assert.equal(D.ownedQty(s, 'XLK', 'mr'), 0);
  assert.ok(Math.abs(D.ownedQty(s, 'XLK', 'mom') - owners.mom) < 1e-6);
});

test('dividends are paid in cash to holders at the previous close', () => {
  const h = synthHist(600, SYMS);
  h.divs = { TLT: { 302: 0.5 } };
  const { s } = fund({ hist: h });
  D.placeManual(s, { symbol: 'TLT', side: 'buy', qty: 1 });
  D.advance(s);                                                   // fills at 301
  const cash = s.account.cash;
  D.advance(s);                                                   // 302: ex-date
  assert.ok(Math.abs(s.account.cash - cash - 0.5) < 1e-9);
  assert.ok(s.log.some(e => /Dividend: TLT/.test(e.text)));
});

test('a manager ticket fills at the next close; buying and selling the same day is a day trade', () => {
  const { s } = fund({ capital: 10000 });
  assert.equal(D.placeManual(s, { symbol: 'GLD', side: 'buy', qty: 2 }).ok, true);
  D.advance(s);
  assert.equal(s.account.positions.GLD.qty, 2);
  D.placeManual(s, { symbol: 'GLD', side: 'sell', qty: 1 });
  D.placeManual(s, { symbol: 'GLD', side: 'buy', qty: 1 });
  D.advance(s);
  assert.deepEqual(D.dayTradeLog(s).map(d => d.symbol), ['GLD']);
});

test('the rotation trims a winner that has grown past its band', () => {
  const { s } = fund({ capital: 10000 });
  for (const o of D.pending(s)) if (o.quantId === 'mom') D.approve(s, o.id);
  D.advance(s);
  const sym = Object.keys(s.account.positions).find(x => D.ownedQty(s, x, 'mom') > 0);
  s.account.positions[sym].qty *= 2; s.account.positions[sym].owners.mom *= 2;  // it doubled
  s.nextRebalance = s.daysRun;
  s.decidedOn = null; D.decide(s);
  const trim = D.pending(s).find(o => o.symbol === sym && o.quantId === 'mom');
  assert.equal(trim?.side, 'sell');
});

test('saved funds stay small, reload, and keep the same market', () => {
  const { s } = fund();
  approveAll(s);
  for (let i = 0; i < 30; i++) D.advance(s);
  const json = JSON.stringify(s);
  assert.ok(json.length < 120000, `saved size ${json.length}`);
  const t = D.migrate(JSON.parse(json));
  D.advance(s); D.advance(t);
  assert.deepEqual(t.sim.prices, s.sim.prices);
  assert.equal(t.daysRun, s.daysRun);
});

test('a version 3 fund (intraday) is converted, keeping its positions and limits', () => {
  const { h, s } = fund({ capital: 1000 });
  approveAll(s); D.advance(s);
  const v3 = JSON.parse(JSON.stringify(s));
  Object.assign(v3, { version: 3, startOfDayEquity: 990, openedDay: v3.sim.day });
  Object.assign(v3.sim, { cursor: v3.sim.cursor + 1, tick: 40, seed: 7, dayOpen: {} });
  v3.settings.speed = 1;
  v3.settings.limits = { ...v3.settings.limits, maxOrderValue: 400, autoMaxOrderValue: 100 };
  v3.orders.push({ id: 999, status: 'pending', quantId: 'mom', symbol: 'XLK', side: 'buy', qty: 1 });
  const m = D.migrate(v3);
  assert.equal(m.version, D.STATE_VERSION);
  assert.equal(m.sim.day, h.dates[s.sim.cursor]);
  assert.deepEqual(Object.keys(m.account.positions).sort(), Object.keys(s.account.positions).sort());
  assert.equal(m.settings.limits.maxOrderPct, 0.4);
  assert.equal(m.settings.limits.maxOrderValue, null);
  assert.equal(m.settings.speed, 'pause');
  assert.equal(m.orders.find(o => o.id === 999).status, 'expired');
  assert.ok(D.advance(m));
});

// The app must trade the strategy the backtest measures. A rotation-only fund in auto mode,
// with limits out of the way, should finish within a small tolerance of the backtest's
// "momentum rotation, top 3" run on the same history (same timing, same costs).
test('the app and the backtest agree on the rotation', () => {
  const h = rotatingMarket(1100);
  D.setMarket(h);
  const start = 300, INVESTED = 0.97;
  const s = D.freshReplayState({ startDate: h.dates[start], capital: 1e6 });
  Object.assign(s.settings.quantModes, { rev: 'off', mr: 'off', cry: 'off' });
  s.settings.sleeves.mom = INVESTED; s.settings.quantAlloc.mom = null;
  s.settings.rotationBand = 0;
  s.settings.limits = { ...s.settings.limits, maxEtfPct: 1, minCashPct: 0, maxOrderPct: 1, dailyLossLimitPct: -1, maxDrawdownPct: null, minOrderValue: 0, autoTiers: ['elite', 'allstar', 'value', 'unproven'], autoMaxOrderPct: 1, sectorLimits: {} };
  s.settings.mode = 'auto';
  D.decide(s);
  while (D.advance(s));
  const app = s.curve.daily.map(d => d.equity);

  const universe = ROTATION_UNIVERSE.filter(x => h.closes[x]);
  const inner = momentumRotation(universe, { topN: 3, cash: null });
  const strat = (hist, t, c) => { const w = inner(hist, t, c); return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v * INVESTED])); };
  const bt = simulate(h, strat, { from: h.dates[start], costBps: x => (x === 'SHY' ? 1 : 10), capital: 1e6 }).equity.map(e => e.value);

  assert.equal(app.length, bt.length);
  const years = (app.length - 1) / 252;
  const cagr = v => Math.pow(v.at(-1) / v[0], 1 / years) - 1;
  const gap = Math.abs(cagr(app) - cagr(bt));
  if (process.env.SHOW) console.log(`app ${(cagr(app) * 100).toFixed(3)}%/yr vs backtest ${(cagr(bt) * 100).toFixed(3)}%/yr`);
  assert.ok(gap < 0.003, `app ${(cagr(app) * 100).toFixed(2)}%/yr vs backtest ${(cagr(bt) * 100).toFixed(2)}%/yr`);
  const fills = s.orders.filter(o => o.status === 'filled').length;
  assert.ok(fills > 20, `the rotation traded (${fills} fills)`);
});

test('a long-running fund is compacted without changing any quant\'s record', () => {
  const h = rotatingMarket(1100);
  D.setMarket(h);
  const s = D.freshReplayState({ startDate: h.dates[300], capital: 10000 });
  D.decide(s);
  for (let i = 0; i < 400; i++) D.advance(s);                    // nobody answers: proposals expire
  const before = JSON.stringify(D.scoreboard(s).map(q => [q.id, q.graded, q.hits]));
  D.compact(s);
  assert.equal(JSON.stringify(D.scoreboard(s).map(q => [q.id, q.graded, q.hits])), before);
  const month = h.dates[s.sim.cursor - 21];
  assert.ok(!s.orders.some(o => o.status === 'expired' && o.created < month), 'old expired proposals dropped');
  assert.ok(s.orders.some(o => o.status === 'expired'), 'recent ones kept');
  assert.ok(s.signals.filter(x => x.status === 'graded').every(x => !x.thesis || x.issuedOn >= h.dates[s.sim.cursor - 63]));
  assert.ok(s.log.length <= D.LOG_LIMIT);
});
