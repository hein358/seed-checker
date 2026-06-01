# 🔍 Seed Phrase Wallet Checker

Paste a seed phrase → get addresses + balances for SOL, ETH, and TRX.
Also checks USDT and USDC token balances on each chain.

## Setup

```bash
npm install
```

## Usage

```bash
node check.mjs
```

Then paste your seed phrases one at a time. Type `q` to quit.

## What it checks

| Chain | Native | Tokens |
|-------|--------|--------|
| Solana | SOL | USDT, USDC |
| Ethereum | ETH | USDT |
| Tron | TRX | USDT (TRC-20) |

## ⚠️ Security

- **Run locally only** — never on a shared/remote machine
- Seeds are only used in memory, never saved to disk
- No data is sent anywhere except blockchain RPCs for balance queries
