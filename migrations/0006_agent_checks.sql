-- Concordium Agent Registry checks for paying Solana wallets (src/concordium/registry.ts), kept for an hour.
CREATE TABLE IF NOT EXISTS agent_checks (
  wallet TEXT NOT NULL,
  solana_network TEXT NOT NULL,
  verified INTEGER NOT NULL,
  badge TEXT,
  body TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (wallet, solana_network)
);
