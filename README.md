# ⊕ SniperFi

**Limit orders for Pump.fun & PumpSwap tokens on Solana.**

Set limit buys, take profits, stop losses & trailing stops on any Pump.fun token. Your orders execute 24/7 — even while you sleep.

![SniperFi Banner](public/assets/banners/sniperfi-banner-1-sleep.svg)

---

## Features

- **Limit Buy** — Buy when token drops to your target price
- **Take Profit** — Auto-sell at 2x, 5x, 10x or any multiplier
- **Stop Loss** — Auto-sell if price drops below threshold
- **Trailing Stop** — Follows price up, sells on pullback from peak
- **Graduation Snipe** — Auto-buy on bonding curve graduation *(coming soon)*

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Frontend   │────▶│   Backend    │────▶│   Solana     │
│  Next.js     │     │  Node.js     │     │  Mainnet     │
│  Vercel      │     │  Hostinger   │     │              │
└─────────────┘     └──────────────┘     └─────────────┘
                          │                      │
                    ┌─────┴─────┐          ┌─────┴─────┐
                    │ Supabase  │          │  Jupiter   │
                    │ Orders DB │          │  Swap API  │
                    └───────────┘          └───────────┘
                          │
                    ┌─────┴─────┐
                    │  Helius   │
                    │ WebSocket │
                    └───────────┘
```

## Tech Stack

| Component    | Tech                | Cost        |
| ------------ | ------------------- | ----------- |
| Frontend     | Static HTML/JS      | Free        |
| Backend      | Node.js             | $4.49/mo    |
| Database     | Supabase            | Free tier   |
| Price Feed   | Helius WebSocket    | Free tier   |
| Execution    | Jupiter SDK         | Free        |
| Wallet       | Solana Web3.js      | Free        |
| **Total**    |                     | **~$5/mo**  |

## Project Structure

```
sniperfi/
├── public/                     # Static frontend
│   ├── index.html              # Landing page (animated)
│   ├── app.html                # Dashboard (real wallet connect)
│   ├── docs.html               # Documentation
│   └── assets/
│       ├── icons/
│       │   ├── favicon.svg     # Crosshair icon (favicon/pfp)
│       │   └── logo.svg        # Full logo with text
│       └── banners/
│           ├── sniperfi-banner-1-sleep.svg
│           ├── sniperfi-banner-2-stoploss.svg
│           ├── sniperfi-banner-3-features.svg
│           ├── sniperfi-banner-4-10x.svg
│           ├── sniperfi-banner-5-howitworks.svg
│           └── sniperfi-twitter-header.svg
├── src/                        # Backend (Node.js)
│   ├── server.js               # Express API server
│   ├── engine.js               # Order matching engine
│   ├── price-monitor.js        # Helius WebSocket price feed
│   ├── executor.js             # Jupiter swap execution
│   └── db.js                   # Supabase client
├── .env.example                # Environment variables template
├── .gitignore
├── package.json
└── README.md
```

## Quick Start

### Prerequisites

- Node.js 18+
- Solana CLI (optional)
- Phantom or Solflare wallet

### Frontend Only (Static)

Just open `public/index.html` in a browser. All pages work standalone with real wallet connect.

### Full Stack

```bash
# Clone
git clone https://github.com/UseSniperFi/sniperfi.git
cd sniperfi

# Install
npm install

# Config
cp .env.example .env
# Edit .env with your keys

# Run
npm run dev
```

### Environment Variables

```env
PORT=3001
HELIUS_API_KEY=your_helius_key
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_anon_key
SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

## Revenue Model

| Fee Type        | Amount        | When                    |
| --------------- | ------------- | ----------------------- |
| Platform Fee    | **0.5%**      | Per filled order only   |
| Create Order    | Free          | —                       |
| Cancel Order    | Free          | —                       |
| Network Fee     | ~0.000005 SOL | Solana tx fee           |

## Security

- **Non-custodial** — We never hold your private keys or funds
- **No blanket approvals** — Each swap requires wallet signature
- **Row-level security** — Orders isolated per wallet in Supabase
- **MEV protection** — Jupiter routes through protected paths

## Links

- **Twitter:** [@UseSniperFi](https://x.com/UseSniperFi)
- **Website:** sniperfi.com *(pending)*

## License

MIT

---

Built on Solana. Powered by Jupiter. ⊕
