# AfriRadar Data API

African investment fund data, sold one request at a time over [x402](https://x402.org) on Solana. **Live on Solana mainnet for real USDC**, and on devnet with free test USDC for anyone who wants to try it without spending. A wallet pays a fraction of a cent in USDC and gets the data back with the Solana transaction that paid for it. There is no account, no API key and no subscription. An AI analyst answers plain-English questions and charges only for the data it reads, inside a spending cap the buyer sets on chain.

The data comes from the regulators:

- **Nigeria:** the SEC's weekly valuation report for every collective investment scheme, 217 funds holding ₦9.88trn (week ended 9 October 2026), weekly since January 2025.
- **Kenya:** the Capital Markets Authority's quarterly statistical bulletin, assets under management for every unit trust scheme, 43 schemes holding KES 851.7bn (quarter ended 31 March 2026), quarterly since December 2023.

Both are read, checked and published by [afriradar.com](https://afriradar.com). This API sells them per request.

[![payments settled](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.afriradar.com%2Fv1%2Fpayments&query=%24.settled.payments&label=payments%20settled%20on%20Solana&color=1dbf8b)](https://api.afriradar.com/#ledger)
[![mainnet payments](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.afriradar.com%2Fv1%2Fpayments&query=%24.networks.mainnet.payments&label=real-USDC%20payments%20on%20mainnet&color=1dbf8b)](https://api.afriradar.com/v1/payments?network=mainnet)
[![visitor wallets](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.afriradar.com%2Fv1%2Fpayments&query=%24.visitors.wallets&label=visitor%20wallets%20that%20paid&color=1dbf8b)](https://api.afriradar.com/v1/payments)
[![hourly checks passed](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.afriradar.com%2Fv1%2Fstatus&query=%24.last7d.passed&label=hourly%20payment%20checks%20passed%20(7d)&color=1dbf8b)](https://api.afriradar.com/v1/status)
[![CI](https://github.com/Risingtell/afriradar-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Risingtell/afriradar-api/actions/workflows/ci.yml)

| | |
|---|---|
| Live demo, no wallet needed | https://api.afriradar.com |
| Verify it in five minutes | [JUDGE-QUICKSTART.md](JUDGE-QUICKSTART.md) |
| Demo video (2:51) | https://youtu.be/4r-gcgAvx74 |
| Pitch deck (PDF, 12 slides) | https://api.afriradar.com/deck.pdf |
| Catalog and prices (free JSON) | https://api.afriradar.com/v1 |
| Public payment ledger | https://api.afriradar.com/v1/payments |
| Live proof that Solana enforces the cap | https://api.afriradar.com/v1/proof/cap |
| Hourly end-to-end payment check | https://api.afriradar.com/v1/status |
| Hosted MCP server, paid tools over x402 | `https://api.afriradar.com/mcp` |
| For language models and agents | [/llms.txt](https://api.afriradar.com/llms.txt), [/discovery/resources](https://api.afriradar.com/discovery/resources) |
| Networks | Solana **mainnet**, real USDC (mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`); Solana devnet, test USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). Every 402 offers both. |
| First real-USDC payments on mainnet | data [3m6KcD...](https://explorer.solana.com/tx/3m6KcDXypfBW9TWsjzJTi2EFYHuWZSZzi2MWejF6ZdcNJjVTZCF7bUETnSeeuRg746wb2tbpN9VbVpdFKqopfX6D); analyst deposit [SoC3i4...](https://explorer.solana.com/tx/SoC3i4vuaTZuNczNEW6o5H1NWBgWiDiBKK2AE4SWPFwK12MT3VRZQg92BwJn1EMeDGyV7nPdtUr9eYnRm3eHPXS) and settlement [5XmChR...](https://explorer.solana.com/tx/5XmChRiNPYeeAM4tudd2DRFfFKEUXBrnzt5gW28DLdBHqc3rADkipJrpBvKBpzEvrpknjXaVmiKP4tYtxp6PEr72) |

## Judging criteria, mapped

Best Use of x402 on Solana. Each claim links to something you can check.

| Criterion | What is built | Check it |
|---|---|---|
| Meaningful integration of x402 and Solana | Both x402 schemes on Solana mainnet and devnet: `exact` for fixed-price data, `upto` on the Solana Foundation payment-channel program for the metered analyst. Our own facilitator runs in the Worker and pays every network fee on both networks. x402 also runs inside MCP (`@x402/mcp`), and every paid route declares x402 Bazaar discovery metadata. | Mainnet, real USDC: `exact` payment [3m6KcD...](https://explorer.solana.com/tx/3m6KcDXypfBW9TWsjzJTi2EFYHuWZSZzi2MWejF6ZdcNJjVTZCF7bUETnSeeuRg746wb2tbpN9VbVpdFKqopfX6D); `upto` deposit of $0.05 [SoC3i4...](https://explorer.solana.com/tx/SoC3i4vuaTZuNczNEW6o5H1NWBgWiDiBKK2AE4SWPFwK12MT3VRZQg92BwJn1EMeDGyV7nPdtUr9eYnRm3eHPXS) and settlement of 0.004328 with the rest refunded [5XmChR...](https://explorer.solana.com/tx/5XmChRiNPYeeAM4tudd2DRFfFKEUXBrnzt5gW28DLdBHqc3rADkipJrpBvKBpzEvrpknjXaVmiKP4tYtxp6PEr72). Devnet: visitor `exact` payment [61YK61...](https://explorer.solana.com/tx/61YK61tHb5VoxX9bBZEzDjQqVerCSAsYrk4iBRQagLY7y8xeEzchczrSkdNsHcUx4mibvCdVniVTYCMwnXbq13xD?cluster=devnet); visitor `upto` deposit [5Vu8mr...](https://explorer.solana.com/tx/5Vu8mrpyFQ7pYtwMn2wabdj4bJsZWSAm1Rv77ypBFVpo7vz47pfkMGi7Qbin41cYUKj5C8WguNGY2VMJotKc7cJY?cluster=devnet) and settlement of 0.00613 with the rest refunded [5mwM8r...](https://explorer.solana.com/tx/5mwM8rYYaBMjRHi14tSTeDuthvPSWhV6uz74QzbGKmSSRgY9ZkGThHBTHE3e7ATYj1MpgQ4tbyX5yfHQBR9vTv1p?cluster=devnet); paid MCP tool call [3JTxW7...](https://explorer.solana.com/tx/3JTxW71bRBWVb6BNDDHQpvfXddChS42PBHj2eohNYnyTfAVQD6STmzRqbYo9wxUtb4egoqy7W4WPMUBGkpfDUTZg?cluster=devnet) |
| Reliability of the payment-to-access flow | Payment settles before data leaves; a failed handler cancels the payment; a late confirmation is checked on chain before refusing; wallets that add safety instructions while signing are accepted. An hourly monitor pays through the real flow and publishes the result. | [/v1/status](https://api.afriradar.com/v1/status); recount the ledger from the chain on the [demo page](https://api.afriradar.com/#ledger) or with `npx afriradar verify` |
| A compelling use case beyond a basic demo | Real regulator data from two countries (SEC Nigeria weekly, CMA Kenya quarterly), an AI analyst that buys only the data it needs inside a cap Solana enforces, and tools for agents (npm SDK, CLI, local and hosted MCP). Outside users have paid from their own wallets. | [Try to overcharge a buyer](https://api.afriradar.com/#proof); visitor payments in the [ledger](https://api.afriradar.com/v1/payments) (`visitors`) |
| Clear documentation and sensible handling of failed payments | This README, [JUDGE-QUICKSTART.md](JUDGE-QUICKSTART.md), [/llms.txt](https://api.afriradar.com/llms.txt). An error is never charged; a failed answer refunds the whole deposit; a failed payment keeps the facilitator's reason in the public ledger. | A question that failed, refunded in full: deposit [5VPjyF...](https://explorer.solana.com/tx/5VPjyFCiVGQzyxBg4p3S3VH4dYLXc4Wy44yD9ehpDZ3ViNcRVLn2T5kMKsvJheAMDnDsMMs7Wp6NYDxRuY6cprMx?cluster=devnet), refund [TUuMwW...](https://explorer.solana.com/tx/TUuMwWGUeErAfuajz7KXVGj562k1tEwtudX9kmqkza7iVtQS5wHj4xfV6M4Y2cBGZ3KmRcbse99XgjxMjQAyzfy?cluster=devnet); [When a payment fails](#when-a-payment-fails) |

## What a request looks like

```
GET /v1/kenya/unit-trusts
<- 402 Payment Required, PAYMENT-REQUIRED header: pay 0.002 USDC to CEunt52v... on Solana mainnet or devnet
-> same request, PAYMENT-SIGNATURE header: a USDC transfer signed by the buyer
   the API's facilitator verifies it, settles it on Solana and runs the handler
<- 200 with the data, PAYMENT-RESPONSE header: { success, transaction, payer }
```

The facilitator runs inside the same Cloudflare Worker as the API and pays the network fee, so a buyer needs USDC (real on mainnet, test on devnet) and no SOL.

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
| `GET /v1/status`, `/v1/proof/cap`, `/discovery/resources`, `POST /mcp` | free | Hourly check results, live cap proof, x402 Bazaar listing, MCP server |

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

### Proof: Solana enforces the cap, not just our code

A buyer should not have to trust our server. [`scripts/cap-proof.ts`](scripts/cap-proof.ts) opens a real `upto` channel with a 0.01 USDC ceiling, then plays a dishonest server: with our own payee and authorizer keys it signs a voucher for the ceiling plus 1 micro-USDC and sends `settle_and_seal` straight to the payment-channel program, skipping every check in our code. The program rejects it on chain. Then the honest 0.003 USDC bill settles and the rest of the deposit goes back to the buyer.

| Step | Result | Transaction |
|---|---|---|
| Buyer deposits the 0.01 ceiling into the channel | confirmed | [2tZFgT...](https://explorer.solana.com/tx/2tZFgTTQyzbqQUnCvJfcw6bjoQCmgq8NKiEaUjDePxdsfu7ygrB7WxmktdNVP11L6mJGyjUJhgEgZxXi3J9xaDVj?cluster=devnet) |
| Payee tries to take 10,001 micro-USDC | **failed on chain**, program error 235 | [3rQ1ea...](https://explorer.solana.com/tx/3rQ1eaaojMQ8i66S9fDg3gt12gnFiE2x4Enok8WRHZJ12uCzxB3JzTp1Jhc6zGv5444NVpttTGjxwHoGQTu6qkfG?cluster=devnet) |
| Honest bill of 3,000 settles, 7,000 refunded | confirmed | [5U2FkB...](https://explorer.solana.com/tx/5U2FkBbrUvocAyiEoixLnyNvzNY96S3uVc7WtPA1GreM1N5pxc6C1GsvaPz2oYkbeHEZXSefQ8xZ16zTAUGfdFo8?cluster=devnet) |

To show the amount is the only reason for the failure, the script also simulates the identical transaction at 3,000 (accepted), at exactly the 10,000 ceiling (accepted) and at 10,001 (rejected, error 235). Across three runs the buyer's balance fell by exactly 3 × 0.003 USDC. The full record is in [`docs/cap-proof.json`](docs/cap-proof.json); run it yourself with `npx tsx scripts/cap-proof.ts`.

**Run it live, in the browser.** The [demo page](https://api.afriradar.com/#proof) has a **Run the attack now** button, also at [`GET /v1/proof/cap`](https://api.afriradar.com/v1/proof/cap). It builds the exact channel-open transaction a buyer sends for a question, adds a `settle_and_seal` for the $0.05 deposit and for one micro-USDC more, and asks a validator to simulate each. The first is accepted and the second is refused by the program, every time, at no cost: a simulation sends nothing. See [`src/proof.ts`](src/proof.ts).

## Agents: hosted MCP, x402 inside MCP, discovery

`https://api.afriradar.com/mcp` is a stateless MCP server (Streamable HTTP). Free tools (`afriradar_catalog`, `afriradar_search`, `afriradar_overview`, `afriradar_status`) answer directly. Paid tools (`afriradar_fund`, `afriradar_history`, `afriradar_category`, `afriradar_top`, `afriradar_compare`, `afriradar_kenya`, `afriradar_kenya_scheme`) charge the same prices over x402 inside MCP with [`@x402/mcp`](https://www.npmjs.com/package/@x402/mcp): the first call returns the price, an x402 MCP client pays in `_meta` and calls again, and the settlement lands in the same public ledger as `mcp://tool/<name>`. A tool that fails is never charged. [`scripts/mcp-pay.ts`](scripts/mcp-pay.ts) makes one paid call with the official client.

```json
{ "mcpServers": { "afriradar": { "url": "https://api.afriradar.com/mcp" } } }
```

Every paid HTTP route declares x402 Bazaar discovery metadata, so its 402 tells an agent how to call it (path parameters, query, body). [`/discovery/resources`](https://api.afriradar.com/discovery/resources) lists every route and MCP tool in the Bazaar format, and [`/llms.txt`](https://api.afriradar.com/llms.txt) describes the API for language models. See [`src/mcp.ts`](src/mcp.ts) and [`src/discovery.ts`](src/discovery.ts).

## Mainnet and devnet side by side

The same Worker sells on both networks. Every 402 lists devnet first and mainnet second, so an x402 client picks the network its wallet is on. Each payment is stored with its network, and the ledger reads `?network=devnet|mainnet|all` (devnet by default).

- **Real money stays deliberate.** The demo wallet and the hourly monitor pay on devnet only. On mainnet you always pay from your own wallet.
- **One facilitator, two chains.** The facilitator pays network fees on both; it reaches mainnet through its own RPC, and the page signs through `/rpc/mainnet`.
- **Guard before payment.** A question is validated before its deposit is taken, and mainnet questions are limited per visitor per hour, so a bad request is refused without charge.
- **Recount it.** On the [demo page](https://api.afriradar.com/#ledger), choose **Mainnet** next to the recount buttons: your browser reads every mainnet payment from Solana and compares it with the ledger.

## Reliability, measured every hour

A cron runs at 41 minutes past every hour: the demo wallet buys one fund through the normal x402 flow, and every six hours it also asks the analyst a question. A check passes only if the payment settled on Solana and the data or answer came back. Results are at [`/v1/status`](https://api.afriradar.com/v1/status) and on the demo page. The monitor's payments are real settlements, so they stay in the public ledger, labelled `monitor` and counted apart from visitors. See [`src/monitor.ts`](src/monitor.ts).

## When a payment fails

- **The request fails** (unknown fund, bad input, AI unavailable): the handler answers 4xx or 5xx and the payment is cancelled. You are never charged for an error.
- **Settlement is broadcast but its confirmation is not seen** (often a rate-limited RPC): before refusing, the server reads the transaction from the chain. If the treasury received the money, the data is released and the ledger notes it was recovered.
- **Still unresolved:** `GET /v1/redeem/:tx` releases the data for free once the chain shows the payment arrived.

Every settlement is written to the public ledger, and a failed payment keeps the facilitator's reason. Anyone can recount the ledger from the chain, in the browser on the [demo page](https://api.afriradar.com/#ledger) or from a terminal:

```
npx afriradar verify --mainnet     # real USDC; leave out --mainnet to recount devnet
...
matched         2 of 2 ledger rows found on chain for the exact amount
OK: every payment the API claims is on chain.
```

## Try it

**In a browser:** open https://api.afriradar.com, pick a product and press Run. The demo pays from a funded devnet wallet, so you need nothing. You can also connect your own Solana wallet (Solflare, Phantom or Backpack, set to devnet); if it has no devnet USDC, the page sends it 0.25 test USDC. To pay real USDC, set **Network** to **Mainnet** and connect a wallet that holds a few cents of USDC on Solana (Phantom, Solflare, Backpack or MetaMask). You still need no SOL.

**From a terminal** (Node 22 or later), with the [`afriradar`](https://www.npmjs.com/package/afriradar) package on npm:

```bash
npx afriradar catalog                      # free
npx afriradar search sanlam                # free: ids for Nigeria and Kenya
npx afriradar wallet --new                 # prints an address; fund it at faucet.circle.com (Solana Devnet)
npx afriradar kenya                        # 0.002 USDC, prints the Solana transaction
npx afriradar ask "Which Kenyan unit trust schemes grew fastest last quarter?"
npx afriradar verify --mainnet             # free: recount the real-USDC payments from Solana
```

Add `--mainnet` to any command to pay real USDC from the same wallet file. You still need no SOL.

The same package is an SDK (`createAfriRadar`) and an MCP server (`afriradar mcp`) so any MCP-capable agent can buy data with its own wallet and a budget. See [packages/afriradar](packages/afriradar).

**With plain HTTP**, to see the 402 yourself:

```bash
curl -i https://api.afriradar.com/v1/kenya/unit-trusts
```

## Run the API yourself

```bash
npm install
npm test                 # 84 tests: data, Kenya, billing rules, facilitator storage, ledger, MCP, discovery, SDK, chain verifier
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
| Worker entry: D1, Workers AI, in-process facilitator, daily and hourly crons | [`src/worker.ts`](src/worker.ts) |
| Live cap proof (simulated over-cap claim) | [`src/proof.ts`](src/proof.ts) |
| Hosted MCP server, x402 inside MCP | [`src/mcp.ts`](src/mcp.ts) |
| x402 Bazaar discovery | [`src/discovery.ts`](src/discovery.ts) |
| Hourly end-to-end payment monitor | [`src/monitor.ts`](src/monitor.ts) |
| Test USDC faucet for visitors' wallets | [`src/faucet.ts`](src/faucet.ts) |
| Durable payment-channel storage for the `upto` facilitator, on D1 | [`src/facilitator/storage.ts`](src/facilitator/storage.ts) |
| Reading a settlement from the chain | [`src/reconcile.ts`](src/reconcile.ts) |
| Nigeria data: CSV ingest and queries | [`src/data`](src/data) |
| Kenya data | [`src/data/kenya.ts`](src/data/kenya.ts) |
| AI analyst and its billing | [`src/agent/ask.ts`](src/agent/ask.ts) |
| Demo page | [`public`](public), [`web`](web) |
| SDK, CLI, MCP server, chain verifier | [`packages/afriradar`](packages/afriradar) |

Stack: `@x402/core`, `@x402/svm`, `@x402/hono`, `@x402/mcp`, `@x402/extensions` 2.28, `@solana/kit` 6.10, Hono, Cloudflare Workers with D1 and Workers AI (`@cf/openai/gpt-oss-120b`).

## What existed before the hackathon

AfriRadar's data site ([afriradar.com](https://afriradar.com), a separate repository) existed before 12 October 2026 and publishes the Nigeria CSVs this API reads. Everything in this repository was built during the Encode Solana Hackathon, starting 13 October 2026, as was the Kenya data on afriradar.com.

## Not investment advice

AfriRadar publishes data reported by fund managers to their regulators, for information only. It is not investment advice.

## License

MIT, see [LICENSE](LICENSE).
