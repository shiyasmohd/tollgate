-- A seller's ENS name, <handle>.<ENS_PARENT> (e.g. hashir.tollgate-x402.eth), with
-- its own ENSv2 subregistry: the seller's listings are named inside it
-- (elevenlabs.hashir.tollgate-x402.eth). See src/ens.ts.
CREATE TABLE sellers (
  address     TEXT PRIMARY KEY,                -- lowercased 0x address
  handle      TEXT NOT NULL UNIQUE,
  ens_name    TEXT NOT NULL,
  registry    TEXT,                            -- the seller's UserRegistry, set once deployed
  status      TEXT NOT NULL CHECK (status IN ('pending', 'registered')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Label the seller picked for the endpoint's ENS name ("elevenlabs"); null: derived from its name.
ALTER TABLE endpoints ADD COLUMN ens_label TEXT;
