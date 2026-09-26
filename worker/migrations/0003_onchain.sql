-- Onchain verification with Curvegrid MultiBaas.

-- USDC Transfers into a seller's payout address, as indexed by MultiBaas: pushed by
-- its webhook, or backfilled from an event query. A settled call is verified when a
-- transfer with its tx_hash landed here with the same amount. One x402 settlement
-- moves USDC to one payTo, so (tx_hash, owner) identifies a transfer.
CREATE TABLE onchain_transfers (
  tx_hash       TEXT NOT NULL,     -- lowercased
  owner         TEXT NOT NULL,     -- Transfer.to, lowercased (= endpoints.owner)
  sender        TEXT NOT NULL,     -- Transfer.from, lowercased
  amount_atomic INTEGER NOT NULL,
  block_number  INTEGER NOT NULL,
  block_time    INTEGER NOT NULL,  -- ms
  source        TEXT NOT NULL CHECK (source IN ('webhook', 'query')),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, owner)
);
CREATE INDEX onchain_owner_time ON onchain_transfers (owner, block_time);
