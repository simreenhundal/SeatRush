-- SeatRush schema.
-- Design rule: the database, not application code, is the last line of defence
-- against overselling. Every invariant that matters is a constraint here.

CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  price_cents INTEGER     NOT NULL CHECK (price_cents >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A hold reserves one or more seats for one user for a short window.
-- Its status is a small state machine:
--   active -> paying -> confirmed
--   active -> released | expired
--   paying -> active (payment failed, user may retry while the hold lasts)
CREATE TABLE holds (
  id          UUID        PRIMARY KEY,
  event_id    BIGINT      NOT NULL REFERENCES events(id),
  user_id     TEXT        NOT NULL,
  status      TEXT        NOT NULL
              CHECK (status IN ('active', 'paying', 'confirmed', 'released', 'expired')),
  expires_at  TIMESTAMPTZ NOT NULL,
  -- Idempotency key of the checkout currently paying for this hold.
  -- Lets a retry with the same key resume an interrupted payment safely.
  checkout_key TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX holds_expiry_idx ON holds (expires_at) WHERE status = 'active';

CREATE TABLE seats (
  id          BIGSERIAL   PRIMARY KEY,
  event_id    BIGINT      NOT NULL REFERENCES events(id),
  label       TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'available'
              CHECK (status IN ('available', 'held', 'sold')),
  hold_id     UUID        REFERENCES holds(id),
  held_until  TIMESTAMPTZ,
  version     INTEGER     NOT NULL DEFAULT 0,   -- used by the optimistic strategy
  UNIQUE (event_id, label),
  -- A seat's columns must agree with its status.
  CHECK (
    (status = 'available' AND hold_id IS NULL AND held_until IS NULL) OR
    (status = 'held'      AND hold_id IS NOT NULL AND held_until IS NOT NULL) OR
    (status = 'sold'      AND hold_id IS NOT NULL)
  )
);
CREATE INDEX seats_event_status_idx ON seats (event_id, status);
CREATE INDEX seats_hold_idx ON seats (hold_id);

CREATE TABLE orders (
  id              UUID        PRIMARY KEY,
  hold_id         UUID        NOT NULL UNIQUE REFERENCES holds(id), -- one order per hold, ever
  user_id         TEXT        NOT NULL,
  amount_cents    INTEGER     NOT NULL,
  charge_id       TEXT        NOT NULL,
  idempotency_key TEXT        NOT NULL UNIQUE,                      -- retries can't create a second order
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
