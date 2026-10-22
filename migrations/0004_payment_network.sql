-- Payments on Solana mainnet as well as devnet: every ledger row says which network it settled on.
ALTER TABLE payments ADD COLUMN network TEXT NOT NULL DEFAULT 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
CREATE INDEX IF NOT EXISTS payments_network_created ON payments (network, created_at);
