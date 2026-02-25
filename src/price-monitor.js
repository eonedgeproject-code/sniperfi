require('dotenv').config();
const WebSocket = require('ws');
const EventEmitter = require('events');

const JUPITER_PRICE_URL = 'https://price.jup.ag/v6/price';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

class PriceMonitor extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.prices = new Map();       // token -> { price, symbol, updatedAt }
    this.watching = new Set();
    this.pollInterval = opts.pollInterval || 3000;  // 3s default
    this._pollTimer = null;
    this._ws = null;
    this._wsReconnectDelay = 1000;
  }

  // ─── Watch / Unwatch ───

  watch(tokenAddress) {
    if (this.watching.has(tokenAddress)) return;
    this.watching.add(tokenAddress);
    console.log(`[price] + watching ${tokenAddress.slice(0, 8)}... (${this.watching.size} total)`);
  }

  unwatch(tokenAddress) {
    this.watching.delete(tokenAddress);
    this.prices.delete(tokenAddress);
    console.log(`[price] - unwatched ${tokenAddress.slice(0, 8)}... (${this.watching.size} total)`);
  }

  getPrice(tokenAddress) {
    const entry = this.prices.get(tokenAddress);
    return entry ? entry.price : null;
  }

  getPriceData(tokenAddress) {
    return this.prices.get(tokenAddress) || null;
  }

  // ─── Jupiter Polling (MVP — reliable, works immediately) ───

  startPolling(intervalMs) {
    this.pollInterval = intervalMs || this.pollInterval;
    console.log(`[price] ● polling started (${this.pollInterval}ms)`);
    this._poll(); // first poll immediately
    this._pollTimer = setInterval(() => this._poll(), this.pollInterval);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      console.log('[price] polling stopped');
    }
  }

  async _poll() {
    if (this.watching.size === 0) return;

    const tokens = Array.from(this.watching);
    const BATCH = 100; // Jupiter supports up to 100 per request

    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);

      try {
        const ids = batch.join(',');
        const url = `${JUPITER_PRICE_URL}?ids=${ids}&vsToken=${SOL_MINT}`;
        const res = await fetch(url);

        if (!res.ok) {
          console.error(`[price] Jupiter API ${res.status}`);
          continue;
        }

        const json = await res.json();
        if (!json.data) continue;

        for (const [addr, info] of Object.entries(json.data)) {
          const newPrice = parseFloat(info.price);
          const old = this.prices.get(addr);
          const oldPrice = old ? old.price : null;

          this.prices.set(addr, {
            price: newPrice,
            symbol: info.mintSymbol || null,
            vsToken: 'SOL',
            updatedAt: Date.now()
          });

          // Emit if price changed
          if (oldPrice !== null && oldPrice !== newPrice) {
            this.emit('priceUpdate', {
              token: addr,
              symbol: info.mintSymbol,
              price: newPrice,
              oldPrice,
              change: ((newPrice - oldPrice) / oldPrice) * 100
            });
          } else if (oldPrice === null) {
            // First price — emit so engine can evaluate immediately
            this.emit('priceUpdate', {
              token: addr,
              symbol: info.mintSymbol,
              price: newPrice,
              oldPrice: null,
              change: 0
            });
          }
        }

        // Mark tokens not in response (not indexed on Jupiter)
        for (const addr of batch) {
          if (!json.data[addr] && !this.prices.has(addr)) {
            this.prices.set(addr, {
              price: null,
              symbol: null,
              vsToken: 'SOL',
              updatedAt: Date.now(),
              error: 'not_indexed'
            });
          }
        }

      } catch (e) {
        console.error('[price] poll error:', e.message);
      }
    }
  }

  // ─── Single token price fetch (for API endpoint) ───

  async fetchPrice(tokenAddress) {
    try {
      const url = `${JUPITER_PRICE_URL}?ids=${tokenAddress}&vsToken=${SOL_MINT}`;
      const res = await fetch(url);
      const json = await res.json();

      if (json.data && json.data[tokenAddress]) {
        const info = json.data[tokenAddress];
        return {
          token: tokenAddress,
          price: parseFloat(info.price),
          symbol: info.mintSymbol,
          vsToken: 'SOL'
        };
      }

      return { token: tokenAddress, price: null, error: 'not_indexed' };
    } catch (e) {
      return { token: tokenAddress, price: null, error: e.message };
    }
  }

  // ─── Helius WebSocket (production — faster, real-time) ───

  connectHelius() {
    const url = process.env.HELIUS_WS_URL;
    if (!url) {
      console.log('[price] HELIUS_WS_URL not set, skipping WebSocket');
      return;
    }

    console.log('[price] connecting Helius WebSocket...');
    this._ws = new WebSocket(url);

    this._ws.on('open', () => {
      console.log('[price] ● Helius WS connected');
      this._wsReconnectDelay = 1000;
    });

    this._ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.method === 'accountNotification') {
          this.emit('accountUpdate', msg.params);
        }
      } catch {}
    });

    this._ws.on('close', () => {
      console.log('[price] Helius WS disconnected');
      setTimeout(() => this.connectHelius(), this._wsReconnectDelay);
      this._wsReconnectDelay = Math.min(this._wsReconnectDelay * 2, 30000);
    });

    this._ws.on('error', (e) => {
      console.error('[price] Helius WS error:', e.message);
    });
  }

  // ─── Cleanup ───

  stop() {
    this.stopPolling();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this.watching.clear();
    this.prices.clear();
  }
}

module.exports = PriceMonitor;
