-- FotoobrazyPRO e-shop schema
-- All money columns are integers in minor units (halíře, Kč x 100).

CREATE SEQUENCE IF NOT EXISTS order_ref_seq START 1;

CREATE TABLE IF NOT EXISTS orders (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_ref        TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created','payment_pending','paid','payment_failed','cancelled')),

  customer_name     TEXT NOT NULL,
  customer_email    TEXT NOT NULL,
  customer_phone    TEXT NOT NULL,

  delivery_method   TEXT NOT NULL,
  delivery_addr     JSONB,

  currency          TEXT NOT NULL DEFAULT 'CZK',
  items_total       INTEGER NOT NULL,
  shipping_total    INTEGER NOT NULL,
  grand_total       INTEGER NOT NULL,
  pricing_version   TEXT NOT NULL,

  gateway           TEXT,
  gateway_trans_id  TEXT UNIQUE,
  gateway_redirect  TEXT,

  idempotency_key   TEXT NOT NULL UNIQUE,
  consent_terms     BOOLEAN NOT NULL DEFAULT FALSE,

  emails_sent_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  print_type    TEXT NOT NULL,
  orientation   TEXT NOT NULL,
  width_cm      INTEGER NOT NULL,
  height_cm     INTEGER NOT NULL,
  retouch       BOOLEAN NOT NULL DEFAULT FALSE,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  unit_price    INTEGER NOT NULL,
  line_total    INTEGER NOT NULL,
  blob_key      TEXT NOT NULL,
  blob_url      TEXT NOT NULL,
  photo_name    TEXT
);

-- Append-only audit trail of every payment-related signal we received/derived.
CREATE TABLE IF NOT EXISTS payment_events (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  source          TEXT NOT NULL,            -- create | notify | return | reconcile
  gateway_status  TEXT,
  raw             JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status        ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_trans_id      ON orders(gateway_trans_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order    ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(order_id);
