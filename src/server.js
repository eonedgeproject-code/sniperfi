require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const Engine = require('./engine');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Health Check ───
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: engine?.isRunning ? 'running' : 'stopped',
    orders: engine?.orders?.length || 0,
    tokens: engine?.monitor?.watching?.size || 0,
    uptime: process.uptime()
  });
});

// ─── Orders API ───

// Create order
app.post('/api/orders', async (req, res) => {
  try {
    const { wallet, token_address, order_type, target_price, target_multiplier, trail_percent, amount_sol, slippage, entry_price } = req.body;

    // Validate
    if (!wallet || !token_address || !order_type || !amount_sol) {
      return res.status(400).json({ error: 'Missing required fields: wallet, token_address, order_type, amount_sol' });
    }

    const validTypes = ['limit_buy', 'take_profit', 'stop_loss', 'trailing_stop'];
    if (!validTypes.includes(order_type)) {
      return res.status(400).json({ error: `Invalid order_type. Must be: ${validTypes.join(', ')}` });
    }

    if (amount_sol < 0.01) {
      return res.status(400).json({ error: 'Minimum order size is 0.01 SOL' });
    }

    if (amount_sol > 100) {
      return res.status(400).json({ error: 'Maximum order size is 100 SOL' });
    }

    // Check concurrent order limit (free tier: 3)
    const existingOrders = await db.getOrdersByWallet(wallet);
    const activeCount = existingOrders.filter(o => o.status === 'active').length;
    if (activeCount >= 3) {
      return res.status(429).json({ error: 'Free tier limit: 3 concurrent orders. Cancel an order or upgrade to Pro.' });
    }

    // Create in DB
    const order = await db.createOrder({
      wallet,
      token_address,
      order_type,
      target_price,
      target_multiplier,
      trail_percent,
      amount_sol,
      slippage,
      entry_price
    });

    // Add to engine
    if (engine) {
      await engine.addOrder(order);
    }

    console.log(`[api] + order ${order.id.slice(0, 8)} | ${order_type} | ${wallet.slice(0, 4)}...${wallet.slice(-4)}`);

    res.status(201).json(order);
  } catch (e) {
    console.error('[api] create order error:', e);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Get orders for wallet
app.get('/api/orders/:wallet', async (req, res) => {
  try {
    const orders = await db.getOrdersByWallet(req.params.wallet);
    res.json(orders);
  } catch (e) {
    console.error('[api] get orders error:', e);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Cancel order
app.delete('/api/orders/:id', async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    const order = await db.cancelOrder(req.params.id, wallet);
    if (!order) {
      return res.status(404).json({ error: 'Order not found or already cancelled' });
    }

    // Remove from engine
    if (engine) {
      await engine.removeOrder(req.params.id);
    }

    console.log(`[api] ✗ cancelled ${req.params.id.slice(0, 8)}`);

    res.json(order);
  } catch (e) {
    console.error('[api] cancel order error:', e);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// Get token price (proxy to Jupiter)
app.get('/api/price/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Check engine cache first
    if (engine) {
      const cached = engine.monitor.getPrice(token);
      if (cached) {
        return res.json({ token, price: cached, source: 'cache' });
      }
    }

    // Fallback to Jupiter
    const jupRes = await fetch(`https://price.jup.ag/v6/price?ids=${token}&vsToken=So11111111111111111111111111111111111111112`);
    const data = await jupRes.json();

    if (data.data?.[token]) {
      res.json({
        token,
        price: data.data[token].price,
        symbol: data.data[token].mintSymbol,
        source: 'jupiter'
      });
    } else {
      res.json({ token, price: null, source: 'jupiter', error: 'Not indexed' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Price lookup failed' });
  }
});

// ─── Start ───

let engine = null;

app.listen(PORT, async () => {
  console.log(`
  ⊕ SniperFi API Server
  ─────────────────────
  Port:     ${PORT}
  Frontend: http://localhost:${PORT}
  API:      http://localhost:${PORT}/api
  Health:   http://localhost:${PORT}/api/health
  `);

  // Start order engine
  try {
    engine = new Engine();
    await engine.start();
  } catch (e) {
    console.error('[server] engine failed to start:', e.message);
    console.log('[server] running in API-only mode (no order execution)');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[server] shutting down...');
  if (engine) engine.stop();
  process.exit(0);
});
