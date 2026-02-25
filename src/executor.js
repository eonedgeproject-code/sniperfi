require('dotenv').config();

const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP = 'https://quote-api.jup.ag/v6/swap';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PLATFORM_FEE_BPS = 50; // 0.5%
const LAMPORTS = 1e9;

class Executor {
  constructor() {
    this.feeWallet = process.env.FEE_WALLET || null;
    if (!this.feeWallet) {
      console.warn('[executor] FEE_WALLET not set — platform fees disabled');
    }
  }

  // ─── Get Jupiter Quote ───

  async getQuote({ inputMint, outputMint, amount, slippageBps = 500 }) {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: Math.floor(amount).toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false'
    });

    if (this.feeWallet) {
      params.set('platformFeeBps', PLATFORM_FEE_BPS.toString());
    }

    const res = await fetch(`${JUPITER_QUOTE}?${params}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jupiter quote failed (${res.status}): ${text}`);
    }

    const quote = await res.json();

    if (quote.error) {
      throw new Error(`Jupiter quote error: ${quote.error}`);
    }

    return quote;
  }

  // ─── Build Swap Transaction ───

  async buildSwapTransaction(quoteResponse, userPublicKey) {
    const body = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    };

    if (this.feeWallet) {
      body.feeAccount = this.feeWallet;
    }

    const res = await fetch(JUPITER_SWAP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jupiter swap build failed (${res.status}): ${text}`);
    }

    const swap = await res.json();

    if (swap.error) {
      throw new Error(`Jupiter swap error: ${swap.error}`);
    }

    return swap;
  }

  // ─── Build Buy (SOL → Token) ───

  async buildBuy({ tokenMint, solAmount, slippage, walletPubkey }) {
    const lamports = Math.floor(solAmount * LAMPORTS);
    const slippageBps = Math.floor((slippage || 5) * 100);

    console.log(`[executor] buy quote: ${solAmount} SOL → ${tokenMint.slice(0, 8)}...`);

    const quote = await this.getQuote({
      inputMint: SOL_MINT,
      outputMint: tokenMint,
      amount: lamports,
      slippageBps
    });

    const swap = await this.buildSwapTransaction(quote, walletPubkey);

    const outAmount = parseInt(quote.outAmount);
    const feeSol = solAmount * (PLATFORM_FEE_BPS / 10000);

    console.log(`[executor] buy ready: ${solAmount} SOL → ${outAmount} tokens | fee: ${feeSol} SOL`);

    return {
      type: 'buy',
      quote,
      swapTransaction: swap.swapTransaction,
      inputMint: SOL_MINT,
      outputMint: tokenMint,
      inAmount: lamports,
      outAmount,
      priceImpact: parseFloat(quote.priceImpactPct || 0),
      feeSol,
      routePlan: quote.routePlan?.map(r => r.swapInfo?.label).filter(Boolean) || []
    };
  }

  // ─── Build Sell (Token → SOL) ───

  async buildSell({ tokenMint, tokenAmount, slippage, walletPubkey }) {
    const slippageBps = Math.floor((slippage || 5) * 100);

    console.log(`[executor] sell quote: ${tokenMint.slice(0, 8)}... → SOL`);

    const quote = await this.getQuote({
      inputMint: tokenMint,
      outputMint: SOL_MINT,
      amount: tokenAmount,
      slippageBps
    });

    const swap = await this.buildSwapTransaction(quote, walletPubkey);

    const outSol = parseInt(quote.outAmount) / LAMPORTS;
    const feeSol = outSol * (PLATFORM_FEE_BPS / 10000);

    console.log(`[executor] sell ready: tokens → ${outSol} SOL | fee: ${feeSol} SOL`);

    return {
      type: 'sell',
      quote,
      swapTransaction: swap.swapTransaction,
      inputMint: tokenMint,
      outputMint: SOL_MINT,
      inAmount: parseInt(quote.inAmount),
      outAmount: parseInt(quote.outAmount),
      outSol,
      priceImpact: parseFloat(quote.priceImpactPct || 0),
      feeSol,
      routePlan: quote.routePlan?.map(r => r.swapInfo?.label).filter(Boolean) || []
    };
  }

  // ─── Get token balance for a wallet ───

  async getTokenBalance(walletPubkey, tokenMint) {
    const rpc = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          walletPubkey,
          { mint: tokenMint },
          { encoding: 'jsonParsed' }
        ]
      })
    });

    const data = await res.json();
    const accounts = data.result?.value || [];

    if (accounts.length === 0) return 0;

    const info = accounts[0].account.data.parsed.info;
    return parseInt(info.tokenAmount.amount);
  }

  // ─── Get SOL balance ───

  async getSolBalance(walletPubkey) {
    const rpc = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [walletPubkey]
      })
    });

    const data = await res.json();
    return (data.result?.value || 0) / LAMPORTS;
  }
}

module.exports = Executor;
