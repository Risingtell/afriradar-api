# Judge quickstart: verify AfriRadar Data API in five minutes

The API is live on **Solana mainnet for real USDC** and on devnet with free test USDC. The first real-USDC payments: data [3m6KcD...](https://explorer.solana.com/tx/3m6KcDXypfBW9TWsjzJTi2EFYHuWZSZzi2MWejF6ZdcNJjVTZCF7bUETnSeeuRg746wb2tbpN9VbVpdFKqopfX6D); analyst deposit [SoC3i4...](https://explorer.solana.com/tx/SoC3i4vuaTZuNczNEW6o5H1NWBgWiDiBKK2AE4SWPFwK12MT3VRZQg92BwJn1EMeDGyV7nPdtUr9eYnRm3eHPXS) and settlement of 0.004328 with the rest refunded [5XmChR...](https://explorer.solana.com/tx/5XmChRiNPYeeAM4tudd2DRFfFKEUXBrnzt5gW28DLdBHqc3rADkipJrpBvKBpzEvrpknjXaVmiKP4tYtxp6PEr72).

Steps 1 to 3 use devnet so you spend nothing. Nothing needs an account, an API key or a wallet until step 4, and even there the page sends you free test USDC, or you can pay real USDC on mainnet.

## 1. Pay for data with no setup (1 minute)

Open https://api.afriradar.com, keep **Demo wallet** selected and press **Pay and run**.

**What proves it:** the result shows the answer, the itemized bill and a Solana devnet transaction. Open the transaction: USDC moved from the demo wallet to the treasury `CEunt52v96nuGTroYhigYhVQyZbDpaWZ69g6isL4BQT8`. For a question, the deposit row and the settled row both appear in the public ledger further down the page, and the rest of the $0.05 deposit went back in the same settlement.

## 2. Try to overcharge a buyer (30 seconds)

On the same page, in **Proof**, press **Run the attack now**.

**What proves it:** our server signs a claim for one micro-USDC more than a buyer's $0.05 deposit and a Solana validator simulates it with the buyer's real channel-open transaction. The claim for exactly $0.05 is accepted; the claim for $0.050001 is refused by the Solana Foundation payment-channel program (`CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`, custom error 235). The same attack sent for real on 18 October 2026 failed on chain: [3rQ1ea...](https://explorer.solana.com/tx/3rQ1eaaojMQ8i66S9fDg3gt12gnFiE2x4Enok8WRHZJ12uCzxB3JzTp1Jhc6zGv5444NVpttTGjxwHoGQTu6qkfG?cluster=devnet). The cap is enforced by Solana, not by our code.

Same thing as JSON: https://api.afriradar.com/v1/proof/cap

## 3. Check our ledger against the chain (30 seconds)

In **Public ledger**, press **Check the latest 50**, or **Recount everything**. Choose **Mainnet** to recount the real-USDC payments. Choose **Solana public RPC** if you do not want to read through our relay.

**What proves it:** your browser reads each payment from Solana and compares the amount with our ledger. Every settled row must be on chain, paid to the treasury, for exactly the amount listed. The same check from a terminal:

```bash
npx afriradar verify --mainnet   # the real-USDC payments
npx afriradar verify             # devnet
```

## 4. Pay from your own wallet (2 minutes)

1. Set Phantom, Solflare or Backpack to **devnet**.
2. On the page choose **My wallet** and connect.
3. If the wallet has no devnet USDC, press **Send me 0.25 test USDC**. You need no SOL: our facilitator pays every network fee.
4. Press **Pay and run** and approve in the wallet.

**What proves it:** the payer in the receipt and in the ledger is your own address.

**With real USDC:** set **Network** to **Mainnet** and connect a wallet that holds a few cents of USDC on Solana (Phantom, Solflare, Backpack or MetaMask). The cheapest request costs $0.001 and you still need no SOL. The receipt and the ledger row are tagged mainnet.

## 5. See the 402 yourself (30 seconds)

```bash
curl -i https://api.afriradar.com/v1/kenya/unit-trusts
```

**What proves it:** `402 Payment Required` with a `PAYMENT-REQUIRED` header (base64 JSON): price, payee and x402 Bazaar call instructions for agents, offered twice: devnet USDC first, then mainnet USDC.

## 6. Let an agent pay over MCP (1 minute)

Point any MCP client at `https://api.afriradar.com/mcp`. Search, overview and status are free; the data tools are paid per call over x402 inside MCP. To watch one paid call end to end with the official `@x402/mcp` client, from a clone of the repo with a funded devnet key in `keys/buyer.json`:

```bash
npx tsx scripts/mcp-pay.ts
```

**What proves it:** the first call returns the price, the client pays, and the data comes back with a Solana transaction. The settlement appears in the ledger as `mcp://tool/afriradar_kenya_scheme`, for example [3JTxW7...](https://explorer.solana.com/tx/3JTxW71bRBWVb6BNDDHQpvfXddChS42PBHj2eohNYnyTfAVQD6STmzRqbYo9wxUtb4egoqy7W4WPMUBGkpfDUTZg?cluster=devnet).

## 7. Reliability, measured every hour

https://api.afriradar.com/v1/status

**What proves it:** every hour the demo wallet buys a fund through the normal x402 flow, and every six hours it also asks the analyst a question. A check passes only if the payment settled on Solana and the data came back. The page shows the last check and the 7-day pass rate.

## Run the tests

```bash
git clone https://github.com/Risingtell/afriradar-api && cd afriradar-api
npm install
npm run typecheck
npm test
```

The same commands run in CI on every push.
