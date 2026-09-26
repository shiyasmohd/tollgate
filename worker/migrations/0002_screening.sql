-- Intercepta payment screening.

-- Screen each payer before accepting their payment (1) or not (0).
ALTER TABLE endpoints ADD COLUMN screen_payers INTEGER NOT NULL DEFAULT 1;

-- One row per payer screening at the paywall: allowed, warned or blocked.
-- Blocked payments never reach the upstream, so they only show up here.
CREATE TABLE screenings (
  id           TEXT PRIMARY KEY,
  endpoint_id  TEXT NOT NULL,
  owner        TEXT NOT NULL,
  payer        TEXT NOT NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('allow', 'warn', 'block')),
  summary      TEXT NOT NULL,
  checks       TEXT NOT NULL,   -- JSON array of screen.ts Check
  amount_atomic INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX screenings_owner_time ON screenings (owner, created_at);
CREATE INDEX screenings_payer ON screenings (owner, payer, created_at);
