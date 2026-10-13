// Alpaca adapter (stocks + crypto). Paper by default; live needs { live: true } explicitly.
// Read-only by default: placeOrder throws until { readOnly: false } is passed.
//
// Keys: either ALPACA_KEY_ID / ALPACA_SECRET_KEY in the environment, or (preferred in Claude
// cloud sessions) a network secret that injects the APCA-API-KEY-ID and APCA-API-SECRET-KEY
// headers for paper-api.alpaca.markets and data.alpaca.markets, so the code never sees them.
// With no env keys, requests go out without auth headers and the network secret adds them.
// Never commit keys.

import { ReadOnlyError } from './adapter.js';
import { sectorOf } from '../core/sectors.js';

const TRADING = { paper: 'https://paper-api.alpaca.markets', live: 'https://api.alpaca.markets' };
const DATA = 'https://data.alpaca.markets';

// Alpaca reports crypto positions as "BTCUSD" and quotes/orders as "BTC/USD".
// Inside the trading floor every crypto symbol is the bare coin: "BTC".
const toCoin = s => s.replace('/', '').replace(/USD$/, '');
const toPair = coin => `${coin}/USD`;

export function createAlpacaBroker({
  keyId = process.env.ALPACA_KEY_ID,
  secretKey = process.env.ALPACA_SECRET_KEY,
  live = false,
  readOnly = true,
  cryptoSymbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'AVAX', 'LTC', 'LINK'],
  fetchImpl = globalThis.fetch
} = {}) {
  const envKeys = !!(keyId && secretKey);
  const base = live ? TRADING.live : TRADING.paper;
  const isCrypto = sym => cryptoSymbols.includes(sym);

  async function call(url, { method = 'GET', body } = {}) {
    const res = await fetchImpl(url, {
      method,
      headers: {
        ...(envKeys ? { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403
        ? (envKeys ? ' Check ALPACA_KEY_ID / ALPACA_SECRET_KEY are paper keys.'
                   : ' No env keys set: check the Alpaca network secret covers this host and uses the APCA-API-KEY-ID / APCA-API-SECRET-KEY headers.')
        : '';
      const err = new Error(`Alpaca ${method} ${new URL(url).pathname} failed (${res.status}): ${data?.message || text}${hint}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    name: live ? 'alpaca-live' : 'alpaca-paper',
    readOnly,
    live,
    auth: envKeys ? 'env' : 'network-secret',

    async getClock() {
      const c = await call(`${base}/v2/clock`);
      return { isOpen: c.is_open, nextOpen: c.next_open, nextClose: c.next_close };
    },

    async getAccount() {
      const a = await call(`${base}/v2/account`);
      return {
        cash: +a.cash,
        equity: +a.equity,
        buyingPower: +a.buying_power,
        lastEquity: +a.last_equity, // equity at the previous close: start-of-day for the loss cap
        dayTradeCount: +a.daytrade_count,
        tradingBlocked: !!a.trading_blocked
      };
    },

    async getPositions() {
      const rows = await call(`${base}/v2/positions`);
      const out = {};
      for (const p of rows) {
        const assetClass = p.asset_class === 'crypto' ? 'crypto' : 'stock';
        const symbol = assetClass === 'crypto' ? toCoin(p.symbol) : p.symbol;
        out[symbol] = {
          qty: +p.qty,
          price: +p.current_price,
          sector: sectorOf(symbol, assetClass),
          assetClass,
          costBasis: +p.cost_basis,
          prevClose: p.lastday_price != null ? +p.lastday_price : null
        };
      }
      return out;
    },

    async getQuote(symbol) {
      if (isCrypto(symbol)) {
        const pair = toPair(symbol);
        const d = await call(`${DATA}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(pair)}`);
        const q = d.quotes[pair];
        return { symbol, bid: q.bp, ask: q.ap, last: (q.bp + q.ap) / 2, at: q.t };
      }
      const d = await call(`${DATA}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`);
      const q = d.quote;
      return { symbol, bid: q.bp, ask: q.ap, last: (q.bp + q.ap) / 2, at: q.t };
    },

    // Daily closes, oldest first, for roughly the last `days` calendar days.
    // Stocks use the free IEX feed and split/dividend-adjusted prices.
    async getBars(symbol, days = 400) {
      const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      const closes = [];
      let token = null;
      do {
        const page = token ? `&page_token=${encodeURIComponent(token)}` : '';
        if (isCrypto(symbol)) {
          const pair = toPair(symbol);
          const d = await call(`${DATA}/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(pair)}&timeframe=1Day&start=${start}&limit=1000${page}`);
          for (const b of d.bars?.[pair] || []) closes.push(b.c);
          token = d.next_page_token;
        } else {
          const d = await call(`${DATA}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}&limit=1000&adjustment=all&feed=iex${page}`);
          for (const b of d.bars || []) closes.push(b.c);
          token = d.next_page_token;
        }
      } while (token);
      return closes;
    },

    // Limit orders only. Stocks are day orders; crypto is good-til-cancelled (Alpaca's rule).
    async placeOrder(order) {
      if (readOnly) throw new ReadOnlyError(this.name);
      if (!(order.limitPrice > 0)) throw new Error('Alpaca orders must carry a limitPrice');
      const crypto = isCrypto(order.symbol);
      const o = await call(`${base}/v2/orders`, {
        method: 'POST',
        body: {
          symbol: crypto ? toPair(order.symbol) : order.symbol,
          qty: String(order.qty),
          side: order.side,
          type: 'limit',
          limit_price: String(+order.limitPrice.toFixed(crypto ? 4 : 2)),
          time_in_force: crypto ? 'gtc' : 'day',
          client_order_id: order.clientOrderId
        }
      });
      return {
        id: o.id,
        status: o.status === 'filled' ? 'filled' : o.status === 'rejected' ? 'rejected' : 'accepted',
        filledQty: +o.filled_qty,
        avgPrice: o.filled_avg_price != null ? +o.filled_avg_price : null,
        brokerStatus: o.status
      };
    },

    async cancelOrder(id) {
      if (readOnly) throw new ReadOnlyError(this.name);
      await call(`${base}/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return { id, status: 'cancel_requested' };
    },

    async listOpenOrders() {
      const rows = await call(`${base}/v2/orders?status=open&limit=100`);
      return rows.map(o => ({
        id: o.id,
        symbol: o.asset_class === 'crypto' ? toCoin(o.symbol) : o.symbol,
        side: o.side,
        qty: +o.qty,
        limitPrice: o.limit_price != null ? +o.limit_price : null,
        status: o.status
      }));
    }
  };
}

// Builds the risk manager's snapshot from any adapter that also exposes lastEquity.
export async function snapshotFrom(broker) {
  const [account, positions] = await Promise.all([broker.getAccount(), broker.getPositions()]);
  return {
    cash: account.cash,
    positions,
    startOfDayEquity: account.lastEquity || account.equity,
    dayTradesUsed: account.dayTradeCount ?? 0
  };
}
