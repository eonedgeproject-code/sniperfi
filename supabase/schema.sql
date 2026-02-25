-- ═══════════════════════════════════════════
-- SniperFi — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT,

  -- Order config
  order_type TEXT NOT NULL CHECK (order_type IN ('limit_buy', 'take_profit', 'stop_loss', 'trailing_stop')),
  target_price NUMERIC,          -- for limit_buy, stop_loss (in SOL)
  target_multiplier NUMERIC,     -- for take_profit (e.g., 5 = 5x)
  trail_percent NUMERIC,         -- for trailing_stop (e.g., 15 = 15%)
  amount_sol NUMERIC NOT NULL,   -- SOL amount to trade
  slippage NUMERIC DEFAULT 5,    -- slippage tolerance %
  entry_price NUMERIC,           -- user's entry price (for take_profit calc)

  -- Status
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'filled', 'cancelled', 'failed')),
  peak_price NUMERIC,            -- trailing stop peak tracker

  -- Fill data
  fill_price NUMERIC,
  fill_tx TEXT,
  fill_sol NUMERIC,
  fee_sol NUMERIC,
  fail_reason TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  filled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_orders_wallet ON orders(wallet);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(token_address);
CREATE INDEX IF NOT EXISTS idx_orders_active ON orders(status, token_address) WHERE status = 'active';

-- Enable Row Level Security
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (for backend)
CREATE POLICY "Service role full access"
  ON orders FOR ALL
  USING (true)
  WITH CHECK (true);

-- Done
SELECT 'SniperFi schema created ✓' AS status;
