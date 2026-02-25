require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/*
  Supabase SQL — run this in the SQL editor to create tables:

  CREATE TABLE orders (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    wallet TEXT NOT NULL,
    token_address TEXT NOT NULL,
    order_type TEXT NOT NULL CHECK (order_type IN ('limit_buy', 'take_profit', 'stop_loss', 'trailing_stop')),
    target_price NUMERIC,
    target_multiplier NUMERIC,
    trail_percent NUMERIC,
    amount_sol NUMERIC NOT NULL,
    slippage NUMERIC DEFAULT 5,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'filled', 'cancelled', 'failed')),
    peak_price NUMERIC,
    entry_price NUMERIC,
    fill_price NUMERIC,
    fill_tx TEXT,
    fill_sol NUMERIC,
    fee_sol NUMERIC,
    created_at TIMESTAMPTZ DEFAULT now(),
    filled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE INDEX idx_orders_wallet ON orders(wallet);
  CREATE INDEX idx_orders_status ON orders(status);
  CREATE INDEX idx_orders_token ON orders(token_address);

  -- Row Level Security
  ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "Users see own orders"
    ON orders FOR SELECT
    USING (wallet = current_setting('request.jwt.claims')::json->>'wallet');

  CREATE POLICY "Users create own orders"
    ON orders FOR INSERT
    WITH CHECK (wallet = current_setting('request.jwt.claims')::json->>'wallet');

  CREATE POLICY "Users update own orders"
    ON orders FOR UPDATE
    USING (wallet = current_setting('request.jwt.claims')::json->>'wallet');
*/

// ─── Order CRUD ───

async function createOrder({ wallet, token_address, order_type, target_price, target_multiplier, trail_percent, amount_sol, slippage, entry_price }) {
  const { data, error } = await supabase
    .from('orders')
    .insert({
      wallet,
      token_address,
      order_type,
      target_price,
      target_multiplier,
      trail_percent,
      amount_sol,
      slippage: slippage || 5,
      entry_price,
      status: 'active'
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getActiveOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function getOrdersByWallet(wallet) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('wallet', wallet)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function cancelOrder(id, wallet) {
  const { data, error } = await supabase
    .from('orders')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('wallet', wallet)
    .eq('status', 'active')
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function fillOrder(id, { fill_price, fill_tx, fill_sol, fee_sol }) {
  const { data, error } = await supabase
    .from('orders')
    .update({
      status: 'filled',
      fill_price,
      fill_tx,
      fill_sol,
      fee_sol,
      filled_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function failOrder(id, reason) {
  const { data, error } = await supabase
    .from('orders')
    .update({
      status: 'failed',
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function updatePeakPrice(id, peak_price) {
  const { error } = await supabase
    .from('orders')
    .update({ peak_price, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

module.exports = {
  supabase,
  createOrder,
  getActiveOrders,
  getOrdersByWallet,
  cancelOrder,
  fillOrder,
  failOrder,
  updatePeakPrice
};
