# AfriRadar Data API

African investment fund data, sold one request at a time over [x402](https://x402.org) on Solana. A wallet pays a fraction of a cent in USDC and gets the data back with the Solana transaction that paid for it. There is no account, no API key and no subscription. An AI analyst answers plain-English questions and charges only for the data it reads, inside a spending cap the buyer sets on chain.

The data comes from the regulators:

- **Nigeria:** the SEC's weekly valuation report for every collective investment scheme, 216 funds holding ₦9.84trn (week ended 2 October 2026), weekly since January 2025.
- **Kenya:** the Capital Markets Authority's quarterly statistical bulletin, assets under management for every unit trust scheme, 43 schemes holding KES 851.7bn (quarter ended 31 March 2026), quarterly since December 2023.

Both are read, checked and published by [afriradar.com](https://afriradar.com). This API sells them per request.

| | |
|---|---|
| Live demo, no wallet needed | https://api.afriradar.com |
| Catalog and prices (free JSON) | https://api.afriradar.com/v1 |
| Public payment ledger | https://api.afriradar.com/v1/payments |
| Network | Solana **devnet**, USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

## What a request looks like

```
GET /v1/kenya/unit-trusts
<- 402 Payment Required, PAYMENT-REQUIRED header: pay 0.002 USDC to CEunt52v... on solana:devnet
-> same request, PAYMENT-SIGNATURE header: a USDC transfer signed by the buyer
   the API's facilitator verifies it, settles it on Solana and runs the handler
<- 200 with the data, PAYMENT-RESPONSE header: { success, transaction, payer }
```

The facilitator runs inside the same Cloudflare Worker as the API and pays the network fee, so a buyer needs devnet USDC and no SOL.

## Products

| Endpoint | Price (USDC) | What you get |
|---|---|---|
| `GET /v1/categories/:category` | 0.002 | Every Nigerian fund in a category for the latest SEC week |
| `GET /v1/funds/:category/:slug` | 0.001 | One fund, latest figures and last 13 weeks |
| `GET /v1/funds/:category/:slug/history` | 0.005 | One fund's full weekly history, with the SEC file for every week |
| `GET /v1/top/:category` | 0.002 | Funds ranked by yield, size or unitholders |
| `GET /v1/compare?ids=` | 0.003 | Up to 5 funds side by side, 4 and 13 week changes |
| `GET /v1/kenya/unit-trusts` | 0.002 | Every Kenyan unit trust scheme for the latest CMA quarter |
| `GET /v1/kenya/unit-trusts/:scheme` | 0.001 | One Kenyan scheme, every quarter since December 2023 |
| `POST /v1/ask` | metered, at most 0.05 | The AI analyst answers a question from the data |
| `GET /v1`, `/v1/overview`, `/v1/search?q=`, `/v1/payments` | free | Catalog, totals, id search, ledger |

All prices come from one list, [`src/catalog.ts`](src/catalog.ts). The x402 route config, the free catalog, the demo page and the analyst's tool prices are all generated from it, so they cannot disagree.

## The analyst and the on-chain spending cap

`POST /v1/ask` uses the x402 `upto` scheme. The buyer deposits a ceiling of 0.05 USDC into a Solana payment channel (the Solana Foundation's payment-channel program, `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`). The analyst, an LLM on Cloudflare Workers AI, answers by calling the same data products the API sells, each at its list price. The bill is:

```
0.001 base + each dataset at list price + 0.0005 per 1,000 AI tokens, never above the ceiling
```

The server settles exactly that bill and the rest of the deposit returns to the buyer in the same settlement. The response itemizes it. A real answer about Kenya, settled on devnet:

```
bill: base 0.001 + kenya_unit_trusts 0.002 + 6,873 AI tokens 0.003437 = 0.006437 USDC (ceiling 0.05, rest refunded)
```

The analyst refuses a tool call that would push the bill past the ceiling, and a refused call is never billed. See [`src/agent/ask.ts`](src/agent/ask.ts).

## When a payment fails

- **The request fails** (unknown fund, bad input, AI unavailable): the handler answers 4xx or 5xx and the payment is cancelled. You are never charged for an error.
- **Settlement is broadcast but its confirmation is not seen** (often a rate-limited RPC): before refusing, the server reads the transaction from the chain. If the treasury received the money, the data is released and the ledger notes it was recovered.
- **Still unresolved:** `GET /v1/redeem/:tx` releases the data for free once the chain shows the payment arrived.

Every settlement is written to the public ledger. Anyone can recount it from the chain:

```
node packages/afriradar/dist/cli.js verify
...
matched         14 of 14 ledger rows found on chain for the exact amount
OK: every payment the API claims is on chain.
```

## Try it

**In a browser:** open https://api.afriradar.com, pick a product and press Run. The demo pays from a funded devnet wallet, so you need nothing. You can also connect your own Solana wallet (Phantom, Solflare) with free devnet USDC from [faucet.circle.com](https://faucet.circle.com).

**From a terminal**, with the CLI in this repo (Node 22 or later):

```bash
git clone https://github.com/Risingtell/afriradar-api && cd afriradar-api
npm install
npm run build -w afriradar

node packages/afriradar/dist/cli.js catalog              # free
node packages/afriradar/dist/cli.js search sanlam        # free: ids for Nigeria and Kenya
node packages/afriradar/dist/cli.js wallet --new         # prints an address; fund it at faucet.circle.com (Solana Devnet)
node packages/afriradar/dist/cli.js kenya                # 0.002 USDC, prints the Solana transaction
node packages/afriradar/dist/cli.js ask "Which Kenyan unit trust schemes grew fastest last quarter?"
```

The same package is an SDK (`createAfriRadar`) and an MCP server (`afriradar mcp`) so any MCP-capable agent can buy data with its own wallet and a budget. See [packages/afriradar](packages/afriradar).

**With plain HTTP**, to see the 402 yourself:

```bash
curl -i https://api.afriradar.com/v1/kenya/unit-trusts
```

## Run the API yourself

```bash
npm install
npm test                 # 50 tests: data, Kenya, billing rules, facilitator storage
npm run typecheck
```

To run the Worker locally, copy `.dev.vars.example` to `.dev.vars`, fill in devnet keys (`npx tsx scripts/keygen.ts` makes them) and a keyed Solana devnet RPC URL, then:

```bash
npx wrangler d1 migrations apply afriradar-api --local
npx wrangler dev
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"     # loads the data from afriradar.com
```

A keyed RPC is needed because Solana's public RPC refuses requests that come from a Cloudflare Worker.

## How it is built

| Part | Where |
|---|---|
| Hono app, x402 middleware, free and paid routes | [`src/app.ts`](src/app.ts) |
| Worker entry: D1, Workers AI, in-process facilitator, daily cron | [`src/worker.ts`](src/worker.ts) |
| Durable payment-channel storage for the `upto` facilitator, on D1 | [`src/facilitator/storage.ts`](src/facilitator/storage.ts) |
| Reading a settlement from the chain | [`src/reconcile.ts`](src/reconcile.ts) |
| Nigeria data: CSV ingest and queries | [`src/data`](src/data) |
| Kenya data | [`src/data/kenya.ts`](src/data/kenya.ts) |
| AI analyst and its billing | [`src/agent/ask.ts`](src/agent/ask.ts) |
| Demo page | [`public`](public), [`web`](web) |
| SDK, CLI, MCP server, chain verifier | [`packages/afriradar`](packages/afriradar) |

Stack: `@x402/core`, `@x402/svm`, `@x402/hono` 2.28, `@solana/kit` 6.10, Hono, Cloudflare Workers with D1 and Workers AI (`@cf/openai/gpt-oss-120b`).

## What existed before the hackathon

AfriRadar's data site ([afriradar.com](https://afriradar.com), a separate repository) existed before 12 October 2026 and publishes the Nigeria CSVs this API reads. Everything in this repository was built during the Encode Solana Hackathon, starting 13 October 2026, as was the Kenya data on afriradar.com.

## Not investment advice

AfriRadar publishes data reported by fund managers to their regulators, for information only. It is not investment advice.

## License

MIT, see [LICENSE](LICENSE).
