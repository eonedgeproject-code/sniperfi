require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const db = require('./db');
const Engine = require('./engine');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`[api] ${req.method} ${req.path}`);
  }
  next();
});

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Health ───

app.get('/api/health', async (req, res) => {
  const dbOk = await db.ping();
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    engine: engine?.isRunning ? 'running' : 'stopped',
    orders: engine?.orders?.length || 0,
    tokens: engine?.monitor?.watching?.size || 0,
    uptime: Math.floor(process.uptime()),
    db: dbOk ? 'connected' : 'error'
  });
});

// ─── Create Order ───

app.post('/api/orders', async (req, res) => {
  try {
    const {
      wallet, token_address, token_symbol, order_type,
      target_price, target_multiplier, trail_percent,
      amount_sol, slippage, entry_price
    } = req.body;

    // Validate required fields
    if (!wallet || !token_address || !order_type || !amount_sol) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['wallet', 'token_address', 'order_type', 'amount_sol']
      });
    }

    // Validate order type
    const validTypes = ['limit_buy', 'take_profit', 'stop_loss', 'trailing_stop'];
    if (!validTypes.includes(order_type)) {
      return res.status(400).json({ error: `Invalid order_type. Must be: ${validTypes.join(', ')}` });
    }

    // Validate amounts
    if (amount_sol < 0.01) return res.status(400).json({ error: 'Min order: 0.01 SOL' });
    if (amount_sol > 100) return res.status(400).json({ error: 'Max order: 100 SOL' });

    // Validate type-specific fields
    if (order_type === 'limit_buy' && !target_price) {
      return res.status(400).json({ error: 'target_price required for limit_buy' });
    }
    if (order_type === 'take_profit' && (!target_multiplier || !entry_price)) {
      return res.status(400).json({ error: 'target_multiplier and entry_price required for take_profit' });
    }
    if (order_type === 'stop_loss' && !target_price) {
      return res.status(400).json({ error: 'target_price required for stop_loss' });
    }
    if (order_type === 'trailing_stop' && !trail_percent) {
      return res.status(400).json({ error: 'trail_percent required for trailing_stop' });
    }

    // Check concurrent order limit (free: 3)
    const activeCount = await db.getActiveOrderCountByWallet(wallet);
    if (activeCount >= 3) {
      return res.status(429).json({
        error: 'Limit reached: 3 concurrent orders (free tier)',
        active: activeCount
      });
    }

    // Create order
    const order = await db.createOrder({
      wallet, token_address, token_symbol, order_type,
      target_price, target_multiplier, trail_percent,
      amount_sol, slippage, entry_price
    });

    // Add to engine
    if (engine) engine.addOrder(order);

    // Notify via WebSocket
    wsNotify(wallet, { type: 'order_created', order });

    console.log(`[api] + ${order_type} | ${wallet.slice(0, 4)}...${wallet.slice(-4)} | ${amount_sol} SOL`);
    res.status(201).json(order);

  } catch (e) {
    console.error('[api] create error:', e.message);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ─── Get Orders ───

app.get('/api/orders/:wallet', async (req, res) => {
  try {
    const { status } = req.query;
    const orders = await db.getOrdersByWallet(req.params.wallet, status || null);
    res.json({ orders, count: orders.length });
  } catch (e) {
    console.error('[api] get orders error:', e.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ─── Cancel Order ───

app.delete('/api/orders/:id', async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: 'wallet required in body' });

    const order = await db.cancelOrder(req.params.id, wallet);
    if (!order) return res.status(404).json({ error: 'Order not found or not active' });

    if (engine) engine.removeOrder(req.params.id);
    wsNotify(wallet, { type: 'order_cancelled', orderId: req.params.id });

    console.log(`[api] ✗ cancelled ${req.params.id.slice(0, 8)}`);
    res.json(order);

  } catch (e) {
    console.error('[api] cancel error:', e.message);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// ─── Stats ───

app.get('/api/stats/:wallet', async (req, res) => {
  try {
    const stats = await db.getStats(req.params.wallet);
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─── Price ───

app.get('/api/price/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Check engine cache
    if (engine) {
      const cached = engine.monitor.getPriceData(token);
      if (cached && cached.price) {
        return res.json({ ...cached, token, source: 'cache' });
      }
    }

    // Fetch from Jupiter
    const data = await engine?.monitor.fetchPrice(token) || { price: null };
    res.json({ ...data, source: 'jupiter' });

  } catch (e) {
    res.status(500).json({ error: 'Price lookup failed' });
  }
});

// ─── SPA Fallback ───

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));
app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'docs.html')));

// ─── WebSocket Server ───

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const wsClients = new Map(); // wallet -> Set<ws>

wss.on('connection', (ws) => {
  let wallet = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Register wallet
      if (msg.type === 'auth' && msg.wallet) {
        wallet = msg.wallet;
        if (!wsClients.has(wallet)) wsClients.set(wallet, new Set());
        wsClients.get(wallet).add(ws);
        ws.send(JSON.stringify({ type: 'auth_ok', wallet }));
        console.log(`[ws] + ${wallet.slice(0, 8)}... connected`);
      }
    } catch {}
  });

  ws.on('close', () => {
    if (wallet && wsClients.has(wallet)) {
      wsClients.get(wallet).delete(ws);
      if (wsClients.get(wallet).size === 0) wsClients.delete(wallet);
      console.log(`[ws] - ${wallet.slice(0, 8)}... disconnected`);
    }
  });

  // Heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Ping clients every 30s
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function wsNotify(wallet, data) {
  const clients = wsClients.get(wallet);
  if (!clients) return;
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ─── Start ───

let engine = null;

server.listen(PORT, async () => {
  console.log('');
  console.log('  ⊕ SniperFi');
  console.log('  ─────────────────────────');
  console.log(`  HTTP:   http://localhost:${PORT}`);
  console.log(`  WS:     ws://localhost:${PORT}/ws`);
  console.log(`  API:    http://localhost:${PORT}/api/health`);
  console.log('  ─────────────────────────');
  console.log('');

  // Start engine
  try {
    engine = new Engine();

    // Forward engine events to WebSocket
    engine.on('orderTriggered', (data) => {
      wsNotify(data.wallet, {
        type: 'order_triggered',
        orderId: data.orderId,
        orderType: data.orderType,
        token: data.token,
        currentPrice: data.currentPrice,
        swapTransaction: data.swapTransaction,
        feeSol: data.feeSol
      });
    });

    await engine.start();
  } catch (e) {
    console.error('[server] engine error:', e.message);
    console.log('[server] running API-only (no order execution)');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[server] shutting down...');
  if (engine) engine.stop();
  wss.close();
  server.close();
  process.exit(0);
});

process.on('unhandledRejection', (e) => {
  console.error('[server] unhandled rejection:', e.message);
});
