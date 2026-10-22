# afriradar

Buy African fund data (SEC Nigeria weekly, CMA Kenya quarterly) one request at a time, paid in USDC on Solana with [x402](https://x402.org). No account, no API key, no subscription: your wallet pays a fraction of a cent and the data comes back with the Solana transaction that paid for it.

The data is the SEC Nigeria weekly valuation report for every collective investment scheme (every week since January 2025) and CMA Kenya's quarterly assets for every unit trust scheme (43 schemes, every quarter since December 2023), published by [AfriRadar](https://afriradar.com). The API runs at `https://api.afriradar.com` on Solana **mainnet** with real USDC and on devnet with free test USDC. This package uses devnet unless you ask for mainnet.

## Try it in two minutes

```bash
npx afriradar catalog                      # free: products and prices
npx afriradar search coronation            # free: find fund ids
npx afriradar wallet --new                 # creates ~/.afriradar/wallet.json, prints its address
```

Send free devnet USDC to that address at [faucet.circle.com](https://faucet.circle.com) (choose Solana Devnet). You need no SOL: the API's facilitator pays the network fee.

```bash
npx afriradar top money-market --limit 5   # $0.002
npx afriradar ask "Which dollar fund has the highest yield this year, and who manages it?"
```

`ask` authorizes at most $0.05 on chain and settles only the itemized bill (base fee, each dataset the analyst read, AI tokens). The rest of the deposit goes back to your wallet in the same settlement.

## Real USDC on mainnet

Add `--mainnet` to any command. The same wallet file pays; put a few cents of USDC on Solana in it. You still need no SOL.

```bash
npx afriradar wallet --mainnet             # the wallet's mainnet USDC balance
npx afriradar top money-market --limit 5 --mainnet
```

In the SDK, pass `network: "mainnet"` to `createAfriRadar`.

## Prices

| Command | Endpoint | Price (USDC) |
|---|---|---|
| `category <c>` | `GET /v1/categories/:category` | 0.002 |
| `fund <id>` | `GET /v1/funds/:category/:slug` | 0.001 |
| `history <id>` | `GET /v1/funds/:category/:slug/history` | 0.005 |
| `top <c>` | `GET /v1/top/:category` | 0.002 |
| `compare <id> ...` | `GET /v1/compare?ids=` | 0.003 |
| `kenya` | `GET /v1/kenya/unit-trusts` | 0.002 |
| `kenya <scheme>` | `GET /v1/kenya/unit-trusts/:scheme` | 0.001 |
| `ask "<q>"` | `POST /v1/ask` | metered, at most 0.05 |
| `catalog`, `search`, `overview` | `GET /v1`, `/v1/search`, `/v1/overview` | free |

A request that fails (unknown fund, bad input, AI unavailable) is never charged.

## SDK

```ts
import { createAfriRadar, loadSigner } from "afriradar";

const api = createAfriRadar({ signer: await loadSigner(), budget: 0.10 });

const { data, receipt } = await api.top("money-market", { by: "yield_ytd", limit: 3 });
console.log(data.funds[0].name, receipt.usdc, receipt.explorer);

const answer = await api.ask("Is Stanbic IBTC Money Market Fund above the median yield?");
console.log(answer.data.answer, answer.data.bill);
```

Any `@solana/kit` `TransactionSigner` works, so a browser wallet adapter can pay instead of a key file. `maxPerRequest` (default 0.05) and `budget` are enforced before anything is signed.

## MCP server for AI agents

```json
{
  "mcpServers": {
    "afriradar": {
      "command": "npx",
      "args": ["-y", "afriradar", "mcp"],
      "env": { "AFRIRADAR_BUDGET": "0.50" }
    }
  }
}
```

The agent gets 8 tools (`afriradar_search`, `afriradar_overview`, `afriradar_top`, `afriradar_category`, `afriradar_fund`, `afriradar_history`, `afriradar_compare`, `afriradar_ask`). Paid tool results include the Solana transaction and the session's spend so far. The budget stops spending at the limit you set. Add `"--mainnet"` to `args` to pay with real USDC.

## Check the books yourself

```bash
npx afriradar verify             # devnet
npx afriradar verify --mainnet   # the real-USDC payments
```

`verify` reads every transaction that paid the AfriRadar treasury straight from Solana, then checks the API's public ledger (`GET /v1/payments`) against it. It fails if the ledger lists a payment the chain does not show for the exact amount.

## Options

`--mainnet` pay and verify with real USDC, `--json` machine-readable output, `--api <url>`, `--rpc <url>` (any Solana RPC for the chosen network), `--max <usdc>`, `--budget <usdc>`. `AFRIRADAR_KEY` (base58 or JSON secret) overrides the wallet file.

Data, not investment advice. MIT licence.
