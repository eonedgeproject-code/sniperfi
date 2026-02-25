require('dotenv').config();

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';
const FEE_BPS = 50; // 0.5%

class Executor {
  constructor() {
    this.feeWallet = process.env.FEE_WALLET;
  }

  /**
   * Get Jupiter quote for a swap
   * @param {string} inputMint - Input token mint
   * @param {string} outputMint - Output token mint
   * @param {number} amount - Amount in lamports/smallest unit
   * @param {number} slippageBps - Slippage in basis points
   */
  async getQuote(inputMint, outputMint, amount, slippageBps = 500) {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false'
    });

    // Add platform fee if configured
    if (this.feeWallet) {
      params.set('platformFeeBps', FEE_BPS.toString());
    }

    const res = await fetch(`${JUPITER_QUOTE_URL}?${params}`);
    if (!res.ok) {
      throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
    }

    return res.json();
  }

  /**
   * Build swap transaction from quote
   * @param {object} quoteResponse - Jupiter quote response
   * @param {string} userPublicKey - User's wallet public key
   */
  async buildSwapTx(quoteResponse, userPublicKey) {
    const body = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    };

    // Add fee account if configured
    if (this.feeWallet) {
      body.feeAccount = this.feeWallet;
    }

    const res = await fetch(JUPITER_SWAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`Jupiter swap build failed: ${res.status} ${await res.text()}`);
    }

    return res.json();
  }

  /**
   * Execute a buy order (SOL → Token)
   * @param {string} tokenMint - Token to buy
   * @param {number} solAmount - SOL amount (in SOL, not lamports)
   * @param {number} slippage - Slippage percentage (e.g., 5 for 5%)
   * @param {string} walletPubkey - User's wallet pubkey
   */
  async buildBuy(tokenMint, solAmount, slippage, walletPubkey) {
    const lamports = Math.floor(solAmount * 1e9);
    const slippageBps = Math.floor(slippage * 100);

    console.log(`[executor] quote: ${solAmount} SOL → ${tokenMint.slice(0, 8)}...`);

    const quote = await this.getQuote(SOL_MINT, tokenMint, lamports, slippageBps);
    const swap = await this.buildSwapTx(quote, walletPubkey);

    return {
      quote,
      swapTransaction: swap.swapTransaction,
      outAmount: parseInt(quote.outAmount),
      priceImpact: parseFloat(quote.priceImpactPct),
      feeSol: solAmount * (FEE_BPS / 10000)
    };
  }

  /**
   * Execute a sell order (Token → SOL)
   * @param {string} tokenMint - Token to sell
   * @param {number} tokenAmount - Token amount in smallest unit
   * @param {number} slippage - Slippage percentage
   * @param {string} walletPubkey - User's wallet pubkey
   */
  async buildSell(tokenMint, tokenAmount, slippage, walletPubkey) {
    const slippageBps = Math.floor(slippage * 100);

    console.log(`[executor] quote: ${tokenMint.slice(0, 8)}... → SOL`);

    const quote = await this.getQuote(tokenMint, SOL_MINT, tokenAmount, slippageBps);
    const swap = await this.buildSwapTx(quote, walletPubkey);

    const outSol = parseInt(quote.outAmount) / 1e9;
    return {
      quote,
      swapTransaction: swap.swapTransaction,
      outSol,
      priceImpact: parseFloat(quote.priceImpactPct),
      feeSol: outSol * (FEE_BPS / 10000)
    };
  }
}

module.exports = Executor;
