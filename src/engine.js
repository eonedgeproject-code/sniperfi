require('dotenv').config();
const PriceMonitor = require('./price-monitor');
const Executor = require('./executor');
const db = require('./db');

class Engine {
  constructor() {
    this.monitor = new PriceMonitor();
    this.executor = new Executor();
    this.orders = [];          // cached active orders
    this.isRunning = false;
    this.checkInterval = null;
  }

  async start() {
    console.log('[engine] ● starting SniperFi order engine...');

    // Load active orders from DB
    this.orders = await db.getActiveOrders();
    console.log(`[engine] loaded ${this.orders.length} active orders`);

    // Watch all unique tokens
    const tokens = new Set(this.orders.map(o => o.token_address));
    for (const token of tokens) {
      this.monitor.watch(token);
    }

    // Start price polling (MVP mode - uses Jupiter Price API)
    this.monitor.startPolling(3000);

    // Listen for price updates
    this.monitor.on('priceUpdate', (data) => this.onPriceUpdate(data));

    // Periodic order check (backup to event-driven)
    this.checkInterval = setInterval(() => this.checkOrders(), 5000);

    this.isRunning = true;
    console.log('[engine] ● running — monitoring', tokens.size, 'tokens');
  }

  stop() {
    this.monitor.disconnect();
    clearInterval(this.checkInterval);
    this.isRunning = false;
    console.log('[engine] stopped');
  }

  async addOrder(order) {
    this.orders.push(order);
    this.monitor.watch(order.token_address);
    console.log(`[engine] + order ${order.id.slice(0, 8)} | ${order.order_type} | ${order.token_address.slice(0, 8)}...`);
  }

  async removeOrder(orderId) {
    this.orders = this.orders.filter(o => o.id !== orderId);

    // Unwatch token if no more orders for it
    const remaining = this.orders.filter(o => o.token_address === orderId);
    if (remaining.length === 0) {
      // find the token address for this order
      // (already removed, so we skip unwatch — cleanup happens on next reload)
    }
  }

  onPriceUpdate({ token, price, symbol, oldPrice }) {
    const relevantOrders = this.orders.filter(
      o => o.token_address === token && o.status === 'active'
    );

    if (relevantOrders.length === 0) return;

    for (const order of relevantOrders) {
      this.evaluateOrder(order, price);
    }
  }

  async checkOrders() {
    // Reload from DB periodically to catch new orders
    try {
      this.orders = await db.getActiveOrders();
    } catch (e) {
      console.error('[engine] failed to reload orders:', e.message);
    }
  }

  async evaluateOrder(order, currentPrice) {
    if (!currentPrice || currentPrice <= 0) return;

    let shouldFill = false;

    switch (order.order_type) {
      case 'limit_buy':
        // Fill when price drops to or below target
        if (currentPrice <= order.target_price) {
          shouldFill = true;
          console.log(`[engine] ◎ MATCH limit_buy | ${order.token_address.slice(0, 8)} | current: ${currentPrice} <= target: ${order.target_price}`);
        }
        break;

      case 'take_profit':
        // Fill when price reaches multiplier of entry
        if (order.entry_price && order.target_multiplier) {
          const targetPrice = order.entry_price * order.target_multiplier;
          if (currentPrice >= targetPrice) {
            shouldFill = true;
            console.log(`[engine] ◎ MATCH take_profit | ${order.token_address.slice(0, 8)} | current: ${currentPrice} >= ${order.target_multiplier}x entry`);
          }
        }
        break;

      case 'stop_loss':
        // Fill when price drops below stop level
        if (order.target_price && currentPrice <= order.target_price) {
          shouldFill = true;
          console.log(`[engine] ◎ MATCH stop_loss | ${order.token_address.slice(0, 8)} | current: ${currentPrice} <= stop: ${order.target_price}`);
        }
        break;

      case 'trailing_stop':
        // Update peak, fill when price drops trail_percent from peak
        if (!order.peak_price || currentPrice > order.peak_price) {
          await db.updatePeakPrice(order.id, currentPrice);
          order.peak_price = currentPrice;
        }

        if (order.peak_price && order.trail_percent) {
          const triggerPrice = order.peak_price * (1 - order.trail_percent / 100);
          if (currentPrice <= triggerPrice) {
            shouldFill = true;
            console.log(`[engine] ◎ MATCH trailing_stop | ${order.token_address.slice(0, 8)} | peak: ${order.peak_price} → dropped ${order.trail_percent}%`);
          }
        }
        break;
    }

    if (shouldFill) {
      await this.executeOrder(order, currentPrice);
    }
  }

  async executeOrder(order, currentPrice) {
    // Prevent double execution
    if (order._executing) return;
    order._executing = true;

    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[engine] ⚡ executing order ${order.id.slice(0, 8)} (attempt ${attempt}/${maxRetries})`);

        let result;

        if (order.order_type === 'limit_buy') {
          // Buy: SOL → Token
          result = await this.executor.buildBuy(
            order.token_address,
            order.amount_sol,
            order.slippage,
            order.wallet
          );
        } else {
          // Sell: Token → SOL (take_profit, stop_loss, trailing_stop)
          // TODO: Need token balance/amount — for now use amount_sol as reference
          // Real implementation needs to look up user's token balance
          result = await this.executor.buildSell(
            order.token_address,
            order.amount_sol * 1e9, // placeholder
            order.slippage,
            order.wallet
          );
        }

        // NOTE: In production, the swap transaction needs to be sent to the
        // user's wallet for signing, OR use a pre-signed authority.
        // For MVP, we return the transaction to the frontend via websocket.

        console.log(`[engine] ✓ order ${order.id.slice(0, 8)} ready for signing`);

        // Mark as filled in DB
        await db.fillOrder(order.id, {
          fill_price: currentPrice,
          fill_tx: 'pending_signature', // updated after user signs
          fill_sol: result.outSol || order.amount_sol,
          fee_sol: result.feeSol
        });

        // Remove from active orders
        this.orders = this.orders.filter(o => o.id !== order.id);

        // Emit event for websocket notification
        this.emit?.('orderFilled', { order, result });

        return; // success

      } catch (e) {
        console.error(`[engine] ✗ attempt ${attempt} failed:`, e.message);

        if (attempt === maxRetries) {
          console.error(`[engine] ✗ order ${order.id.slice(0, 8)} failed after ${maxRetries} attempts`);
          await db.failOrder(order.id);
          this.orders = this.orders.filter(o => o.id !== order.id);
        } else {
          // Wait before retry
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }

    order._executing = false;
  }
}

// Run standalone
if (require.main === module) {
  const engine = new Engine();
  engine.start().catch(console.error);

  process.on('SIGINT', () => {
    engine.stop();
    process.exit(0);
  });
}

module.exports = Engine;
