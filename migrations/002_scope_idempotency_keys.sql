-- A globally unique key let one buyer's choice of key block another buyer's
-- checkout, and revealed which keys were already in use.
ALTER TABLE orders DROP CONSTRAINT orders_idempotency_key_key;
ALTER TABLE orders ADD CONSTRAINT orders_user_idempotency_key UNIQUE (user_id, idempotency_key);
