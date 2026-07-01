-- Add chain_id and contract_address to avoid cross-chain/cross-contract collisions
ALTER TABLE zksend_payments ADD COLUMN IF NOT EXISTS chain_id TEXT NOT NULL DEFAULT '0';
ALTER TABLE zksend_payments ADD COLUMN IF NOT EXISTS contract_address TEXT NOT NULL DEFAULT '';

-- Replace unique constraint: one row per (chain_id, contract_address, payment_id)
ALTER TABLE zksend_payments DROP CONSTRAINT IF EXISTS zksend_payments_payment_id_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'zksend_payments_chain_contract_payment_key'
  ) THEN
    ALTER TABLE zksend_payments
      ADD CONSTRAINT zksend_payments_chain_contract_payment_key
      UNIQUE (chain_id, contract_address, payment_id);
  END IF;
END $$;

-- Index for lookups by chain/contract
CREATE INDEX IF NOT EXISTS idx_zksend_chain_contract
  ON zksend_payments(chain_id, contract_address);

-- Recreate view with new columns (DROP required: column order/count changed)
DROP VIEW IF EXISTS zksend_pending_payments;
CREATE VIEW zksend_pending_payments AS
SELECT
  id,
  chain_id,
  contract_address,
  payment_id,
  sender_address,
  recipient_identity_hash,
  social_platform,
  recipient_username,
  recipient_username_raw,
  amount,
  currency,
  created_at,
  tx_hash
FROM zksend_payments
WHERE claimed = FALSE
ORDER BY created_at DESC;

-- Re-grant access to view
GRANT SELECT ON zksend_pending_payments TO authenticated;
GRANT SELECT ON zksend_pending_payments TO anon;
