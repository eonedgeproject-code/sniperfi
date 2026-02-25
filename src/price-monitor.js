require('dotenv').config();
const WebSocket = require('ws');
const EventEmitter = require('events');

class PriceMonitor extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.prices = new Map();       // token_address -> current_price_sol
    this.watching = new Set();     // token addresses being watched
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.pingInterval = null;
  }

  connect() {
    const url = process.env.HELIUS_WS_URL;
    if (!url) {
      console.error('[price-monitor] HELIUS_WS_URL not set');
      return;
    }

    console.log('[price-monitor] connecting to Helius...');
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[price-monitor] ● connected');
      this.reconnectDelay = 1000;

      // Re-subscribe all watched tokens
      for (const token of this.watching) {
        this._subscribe(token);
      }

      // Keep alive
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      } catch (e) {
        // ignore parse errors
      }
    });

    this.ws.on('close', () => {
      console.log('[price-monitor] disconnected, reconnecting in', this.reconnectDelay + 'ms');
      clearInterval(this.pingInterval);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    });

    this.ws.on('error', (err) => {
      console.error('[price-monitor] error:', err.message);
    });
  }

  watch(tokenAddress) {
    this.watching.add(tokenAddress);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._subscribe(tokenAddress);
    }
    console.log(`[price-monitor] watching ${tokenAddress.slice(0, 8)}... (${this.watching.size} total)`);
  }

  unwatch(tokenAddress) {
    this.watching.delete(tokenAddress);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._unsubscribe(tokenAddress);
    }
  }

  getPrice(tokenAddress) {
    return this.prices.get(tokenAddress) || null;
  }

  _subscribe(tokenAddress) {
    // Subscribe to token account changes via Helius
    // This watches the token's liquidity pool for price changes
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'accountSubscribe',
      params: [
        tokenAddress,
        { encoding: 'jsonParsed', commitment: 'confirmed' }
      ]
    }));
  }

  _unsubscribe(tokenAddress) {
    // TODO: track subscription IDs and unsubscribe properly
  }

  _handleMessage(msg) {
    // Handle account change notifications
    if (msg.method === 'accountNotification') {
      const { subscription, result } = msg.params || {};
      // Parse price from account data
      // This is simplified — real implementation needs to decode
      // the AMM pool state to calculate token price
      this.emit('accountUpdate', result);
    }

    // Handle subscription confirmations
    if (msg.result && typeof msg.result === 'number') {
      // subscription ID received
    }
  }

  // Alternative: Poll Jupiter Price API (simpler, works immediately)
  async pollPrices() {
    if (this.watching.size === 0) return;

    const tokens = Array.from(this.watching);
    const batchSize = 50;

    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      const ids = batch.join(',');

      try {
        const res = await fetch(`https://price.jup.ag/v6/price?ids=${ids}&vsToken=So11111111111111111111111111111111111111112`);
        const data = await res.json();

        if (data.data) {
          for (const [addr, info] of Object.entries(data.data)) {
            const oldPrice = this.prices.get(addr);
            const newPrice = info.price;

            this.prices.set(addr, newPrice);

            if (oldPrice !== newPrice) {
              this.emit('priceUpdate', {
                token: addr,
                price: newPrice,
                symbol: info.mintSymbol,
                oldPrice
              });
            }
          }
        }
      } catch (e) {
        console.error('[price-monitor] Jupiter poll error:', e.message);
      }
    }
  }

  // Start polling mode (recommended for MVP)
  startPolling(intervalMs = 3000) {
    console.log(`[price-monitor] polling mode started (${intervalMs}ms interval)`);
    this.pollPrices();
    this._pollTimer = setInterval(() => this.pollPrices(), intervalMs);
  }

  stopPolling() {
    clearInterval(this._pollTimer);
  }

  disconnect() {
    this.stopPolling();
    clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = PriceMonitor;
