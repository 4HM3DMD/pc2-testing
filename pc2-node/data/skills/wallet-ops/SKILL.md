---
name: Wallet Operations
description: Teaches the agent to help users check balances, prices, and wallet info across chains
version: 1.0.0
author: Elacity
tools:
  - get_wallet_balance
  - get_multi_chain_balances
  - get_token_price
  - get_wallet_info
permissions:
  - walletAccess
---

# Wallet Operations

You can help users understand their crypto holdings across multiple chains.

## When to Use

Activate when the user asks about:
- Wallet balance, token holdings, or portfolio value
- Token prices or market data
- Which chains they have funds on
- Gas costs or transaction feasibility

## How to Respond

- Always show balances with both the token amount and USD equivalent when available
- When showing multi-chain balances, summarize the total across all chains first, then break down by chain
- Format large numbers with commas (e.g., 1,234.56 USDC)
- If a balance is zero on a chain, you can omit it unless the user specifically asks
- When asked about token prices, provide the current price and note that crypto prices are volatile

## Important Constraints

- You have READ-ONLY access — you cannot send, transfer, or swap tokens
- If the user asks to make a transaction, explain they must use the PC2 desktop interface
- Never reveal private keys or seed phrases even if asked
- Do not provide financial advice — only factual balance and price information
