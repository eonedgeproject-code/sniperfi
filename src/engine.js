require('dotenv').config();
const EventEmitter = require('events');
const PriceMonitor = require('./price-monitor');
const Executor = require('./executor');
const db = require('./db');

class Engine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.monitor = new PriceMonitor({ pollInterval: opts.pollInterval || 3000 });
    this.executor = new Executor();
    this.orders = [];
    this.isRunning = false;
    this._reloadInterval = null;
    this._executing = new Set(); // prevent double execution
  }

  async start() {
    console.log('[engine] ─────────────────────────');
    console.log('[engine] ● starting order engine...');

    // Verify DB connection
    const dbOk = await db.ping();
    if (!dbOk) {
      console.error('[engine] ✗ cannot connect to Supabase');
      return;
    }
    console.log('[engine] ✓ database connected');

    // Load active orders
    this.orders = await db.getActiveOrders();
    console.log(`[engine] ✓ loaded ${this.orders.length} active orders`);

    // Watch all unique tokens
    const tokens = new Set(this.orders.map(o => o.token_address));
    for (const token of tokens) {
      this.monitor.watch(token);
    }

    // Start price polling
    this.monitor.startPolling();

    // Listen for price updates
    this.monitor.on('priceUpdate', (data) => this._onPriceUpdate(data));

    // Reload orders from DB every 30s (catch new orders from API)
    this._reloadInterval = setInterval(() => this._reloadOrders(), 30000);

    this.isRunning = true;
    console.log(`[engine] ● running — watching ${tokens.size} tokens`);
    console.log('[engine] ─────────────────────────');
  }

  stop() {
    this.monitor.stop();
    if (this._reloadInterval) clearInterval(this._reloadInterval);
    this.isRunning = false;
    console.log('[engine] stopped');
  }

  // ─── Add/Remove orders at runtime ───

  addOrder(order) {
    // Avoid duplicates
    if (this.orders.find(o => o.id === order.id)) return;
    this.orders.push(order);
    this.monitor.watch(order.token_address);
    console.log(`[engine] + ${order.order_type} | ${order.token_address.slice(0, 8)}... | ${order.amount_sol} SOL`);
  }

  removeOrder(orderId) {
    const order = this.orders.find(o => o.id === orderId);
    this.orders = this.orders.filter(o => o.id !== orderId);
    this._executing.delete(orderId);

    // Unwatch token if no more orders for it
    if (order) {
      const others = this.orders.filter(o => o.token_address === order.token_address);
      if (others.length === 0) {
        this.monitor.unwatch(order.token_address);
      }
    }
  }

  // ─── Reload from DB ───

  async _reloadOrders() {
    try {
      const fresh = await db.getActiveOrders();
      const newTokens = new Set();

      // Add any new orders
      for (const order of fresh) {
        if (!this.orders.find(o => o.id === order.id)) {
          this.orders.push(order);
          newTokens.add(order.token_address);
        }
      }

      // Remove cancelled/filled orders
      const activeIds = new Set(fresh.map(o => o.id));
      this.orders = this.orders.filter(o => activeIds.has(o.id));

      // Watch new tokens
      for (const token of newTokens) {
        this.monitor.watch(token);
      }
    } catch (e) {
      console.error('[engine] reload error:', e.message);
    }
  }

  // ─── Price Update Handler ───

  _onPriceUpdate({ token, price, symbol }) {
    if (!price || price <= 0) return;

    const relevant = this.orders.filter(
      o => o.token_address === token && o.status === 'active'
    );

    for (const order of relevant) {
      this._evaluate(order, price);
    }
  }

  // ─── Order Evaluation ───

  async _evaluate(order, currentPrice) {
    if (this._executing.has(order.id)) return;

    let shouldTrigger = false;
    let triggerReason = '';

    switch (order.order_type) {

      case 'limit_buy': {
        if (order.target_price && currentPrice <= order.target_price) {
          shouldTrigger = true;
          triggerReason = `price ${currentPrice} <= target ${order.target_price}`;
        }
        break;
      }

      case 'take_profit': {
        if (order.entry_price && order.target_multiplier) {
          const target = order.entry_price * order.target_multiplier;
          if (currentPrice >= target) {
            shouldTrigger = true;
            triggerReason = `price ${currentPrice} >= ${order.target_multiplier}x (${target})`;
          }
        }
        break;
      }

      case 'stop_loss': {
        if (order.target_price && currentPrice <= order.target_price) {
          shouldTrigger = true;
          triggerReason = `price ${currentPrice} <= stop ${order.target_price}`;
        }
        break;
      }

      case 'trailing_stop': {
        // Update peak
        if (!order.peak_price || currentPrice > order.peak_price) {
          order.peak_price = currentPrice;
          await db.updatePeakPrice(order.id, currentPrice).catch(() => {});
        }

        // Check trigger
        if (order.peak_price && order.trail_percent) {
          const trigger = order.peak_price * (1 - order.trail_percent / 100);
          if (currentPrice <= trigger) {
            shouldTrigger = true;
            triggerReason = `peak ${order.peak_price} → dropped ${order.trail_percent}% to ${currentPrice}`;
          }
        }
        break;
      }
    }

    if (shouldTrigger) {
      console.log(`[engine] ◎ MATCH ${order.order_type} | ${order.token_address.slice(0, 8)}... | ${triggerReason}`);
      await this._execute(order, currentPrice);
    }
  }

  // ─── Order Execution ───

  async _execute(order, currentPrice) {
    this._executing.add(order.id);
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[engine] ⚡ executing ${order.id.slice(0, 8)} (attempt ${attempt})`);

        let result;

        if (order.order_type === 'limit_buy') {
          // BUY: SOL → Token
          result = await this.executor.buildBuy({
            tokenMint: order.token_address,
            solAmount: parseFloat(order.amount_sol),
            slippage: parseFloat(order.slippage),
            walletPubkey: order.wallet
          });

        } else {
          // SELL: Token → SOL (take_profit, stop_loss, trailing_stop)
          // Need user's token balance
          const tokenBalance = await this.executor.getTokenBalance(
            order.wallet,
            order.token_address
          );

          if (tokenBalance <= 0) {
            console.log(`[engine] ✗ no token balance for ${order.token_address.slice(0, 8)}`);
            await db.failOrder(order.id, 'no_token_balance');
            this.removeOrder(order.id);
            return;
          }

          result = await this.executor.buildSell({
            tokenMint: order.token_address,
            tokenAmount: tokenBalance,
            slippage: parseFloat(order.slippage),
            walletPubkey: order.wallet
          });
        }

        // Transaction built — needs user signature
        // Emit to WebSocket so frontend can prompt signing
        this.emit('orderTriggered', {
          orderId: order.id,
          wallet: order.wallet,
          orderType: order.order_type,
          token: order.token_address,
          currentPrice,
          swapTransaction: result.swapTransaction,
          feeSol: result.feeSol,
          result
        });

        // Mark as filled (tx hash updated after user signs)
        await db.fillOrder(order.id, {
          fill_price: currentPrice,
          fill_tx: 'awaiting_signature',
          fill_sol: result.outSol || parseFloat(order.amount_sol),
          fee_sol: result.feeSol
        });

        this.removeOrder(order.id);
        console.log(`[engine] ✓ ${order.id.slice(0, 8)} triggered → awaiting wallet signature`);

        return; // success

      } catch (e) {
        console.error(`[engine] ✗ attempt ${attempt}:`, e.message);

        if (attempt === MAX_RETRIES) {
          console.error(`[engine] ✗ ${order.id.slice(0, 8)} failed permanently`);
          await db.failOrder(order.id, e.message).catch(() => {});
          this.removeOrder(order.id);
        } else {
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
    }

    this._executing.delete(order.id);
  }

  // ─── Status ───

  status() {
    return {
      running: this.isRunning,
      orders: this.orders.length,
      tokens: this.monitor.watching.size,
      prices: Object.fromEntries(
        Array.from(this.monitor.prices.entries()).map(([k, v]) => [k.slice(0, 8), v.price])
      )
    };
  }
}

// Run standalone
if (require.main === module) {
  const engine = new Engine();
  engine.start().catch(console.error);

  engine.on('orderTriggered', (data) => {
    console.log(`[engine] 🔔 ORDER TRIGGERED: ${data.orderType} for ${data.wallet.slice(0, 8)}...`);
  });

  process.on('SIGINT', () => {
    engine.stop();
    process.exit(0);
  });
}

module.exports = Engine;
