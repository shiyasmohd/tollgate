-- SIWE nonces: single use, short lived.
CREATE TABLE nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- A paid endpoint. owner is the seller's lowercased 0x address and the payTo.
CREATE TABLE endpoints (
  id              TEXT PRIMARY KEY,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  method          TEXT NOT NULL,
  url             TEXT NOT NULL,
  auth_type       TEXT NOT NULL CHECK (auth_type IN ('none', 'header', 'query')),
  auth_name       TEXT,
  auth_value_enc  TEXT,                -- AES-GCM ciphertext, never returned by the API
  static_headers  TEXT NOT NULL DEFAULT '{}',
  price_atomic    INTEGER NOT NULL CHECK (price_atomic > 0),  -- USDC, 6 decimals
  example_query   TEXT,
  example_body    TEXT,
  body_overrides  TEXT,                -- JSON object merged over the buyer's JSON body
  max_body_bytes  INTEGER NOT NULL DEFAULT 65536,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'paused', 'deleted')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX endpoints_owner ON endpoints (owner, status);

-- One row per request that reached the upstream (paid or failed-and-not-charged).
CREATE TABLE calls (
  id               TEXT PRIMARY KEY,
  endpoint_id      TEXT NOT NULL,
  owner            TEXT NOT NULL,
  payer            TEXT,
  amount_atomic    INTEGER NOT NULL DEFAULT 0,
  tx_hash          TEXT,
  settled          INTEGER NOT NULL DEFAULT 0,
  upstream_status  INTEGER NOT NULL,
  latency_ms       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX calls_owner_time ON calls (owner, created_at);
CREATE INDEX calls_endpoint_time ON calls (endpoint_id, created_at);
