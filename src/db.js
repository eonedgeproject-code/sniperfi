require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('[db] ✗ SUPABASE_URL and SUPABASE_KEY required in .env');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── ORDERS ───

async function createOrder({ wallet, token_address, token_symbol, order_type, target_price, target_multiplier, trail_percent, amount_sol, slippage, entry_price }) {
  const { data, error } = await supabase
    .from('orders')
    .insert({
      wallet,
      token_address,
      token_symbol: token_symbol || null,
      order_type,
      target_price: target_price || null,
      target_multiplier: target_multiplier || null,
      trail_percent: trail_percent || null,
      amount_sol,
      slippage: slippage || 5,
      entry_price: entry_price || null,
      status: 'active'
    })
    .select()
    .single();

  if (error) throw new Error(`createOrder: ${error.message}`);
  return data;
}

async function getActiveOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getActiveOrders: ${error.message}`);
  return data || [];
}

async function getOrdersByWallet(wallet, status = null) {
  let query = supabase
    .from('orders')
    .select('*')
    .eq('wallet', wallet)
    .order('created_at', { ascending: false })
    .limit(100);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(`getOrdersByWallet: ${error.message}`);
  return data || [];
}

async function getOrderById(id) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
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

  if (error) throw new Error(`cancelOrder: ${error.message}`);
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

  if (error) throw new Error(`fillOrder: ${error.message}`);
  return data;
}

async function failOrder(id, reason = '') {
  const { data, error } = await supabase
    .from('orders')
    .update({
      status: 'failed',
      fail_reason: reason,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`failOrder: ${error.message}`);
  return data;
}

async function updatePeakPrice(id, peak_price) {
  const { error } = await supabase
    .from('orders')
    .update({ peak_price, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`updatePeakPrice: ${error.message}`);
}

async function getActiveOrderCountByWallet(wallet) {
  const { count, error } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('wallet', wallet)
    .eq('status', 'active');

  if (error) throw new Error(`getActiveOrderCount: ${error.message}`);
  return count || 0;
}

async function getStats(wallet) {
  const { data, error } = await supabase
    .from('orders')
    .select('status, fill_sol, amount_sol, fee_sol')
    .eq('wallet', wallet);

  if (error) throw new Error(`getStats: ${error.message}`);

  const filled = data.filter(o => o.status === 'filled');
  const active = data.filter(o => o.status === 'active');

  let totalPnl = 0;
  let wins = 0;
  filled.forEach(o => {
    const pnl = (o.fill_sol || 0) - (o.amount_sol || 0) - (o.fee_sol || 0);
    totalPnl += pnl;
    if (pnl > 0) wins++;
  });

  return {
    total_orders: data.length,
    active_orders: active.length,
    filled_orders: filled.length,
    total_pnl: Math.round(totalPnl * 10000) / 10000,
    win_rate: filled.length > 0 ? Math.round((wins / filled.length) * 100) : 0,
    total_fees: filled.reduce((sum, o) => sum + (o.fee_sol || 0), 0)
  };
}

// ─── Health check ───
async function ping() {
  try {
    const { error } = await supabase.from('orders').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

module.exports = {
  supabase,
  createOrder,
  getActiveOrders,
  getOrdersByWallet,
  getOrderById,
  cancelOrder,
  fillOrder,
  failOrder,
  updatePeakPrice,
  getActiveOrderCountByWallet,
  getStats,
  ping
};
