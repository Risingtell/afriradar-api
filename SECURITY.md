# Security policy

AfriRadar Data API runs on Solana devnet and moves only devnet USDC. It still holds keys that sign real transactions on that network: the facilitator's fee payer, the `upto` voucher authorizer and the demo wallet.

## Reporting a vulnerability

Email **hello@afriradar.com** with "security" in the subject. Please include what you found, how to reproduce it, and what an attacker could do with it. You will get a reply within three days. Please do not open a public issue for a vulnerability.

## In scope

- Getting data without paying, or being charged without getting data.
- Charging a buyer more than the amount they authorized, or more than the itemized bill for a question.
- Making the facilitator sign or pay for a transaction it should not.
- Reading or abusing the server's RPC key through the `/rpc` relay.
- Anything that makes the public ledger disagree with the chain.

## Out of scope

- Rate limits on the free demo, faucet and proof endpoints being reached.
- Findings that need a compromised device or browser.
