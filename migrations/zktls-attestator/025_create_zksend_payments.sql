-- Create zksend_payments table for tracking zkSEND payments
CREATE TABLE IF NOT EXISTS zksend_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id BIGINT NOT NULL UNIQUE,  -- Payment ID from smart contract
  sender_address TEXT NOT NULL,
  recipient_identity_hash TEXT NOT NULL,  -- Hash of social identity (platform:username)
  social_platform TEXT NOT NULL,  -- twitter, telegram, instagram, tiktok, twitch
  recipient_username TEXT,  -- normalized: lowercase, trim, leading @ stripped only
  recipient_username_raw TEXT,  -- as received from user (optional)
  amount TEXT NOT NULL,  -- BigInt as string
  currency TEXT NOT NULL,  -- USDC, EURC
  recipient_wallet TEXT,  -- NULL until claimed
  claimed BOOLEAN DEFAULT FALSE,
  claimed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  tx_hash TEXT,  -- Transaction hash for payment creation
  claim_tx_hash TEXT,  -- Transaction hash for claim
  
  -- Indexes for efficient queries
  CONSTRAINT zksend_payments_payment_id_key UNIQUE (payment_id)
);

-- Add username columns if table already existed (idempotent for existing DBs)
ALTER TABLE zksend_payments ADD COLUMN IF NOT EXISTS recipient_username TEXT;
ALTER TABLE zksend_payments ADD COLUMN IF NOT EXISTS recipient_username_raw TEXT;

-- Index for querying by identity hash
CREATE INDEX IF NOT EXISTS idx_zksend_recipient_identity 
  ON zksend_payments(recipient_identity_hash, claimed);

-- Index for querying by sender
CREATE INDEX IF NOT EXISTS idx_zksend_sender 
  ON zksend_payments(sender_address);

-- Index for querying by platform
CREATE INDEX IF NOT EXISTS idx_zksend_platform 
  ON zksend_payments(social_platform);

-- Enable RLS
ALTER TABLE zksend_payments ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can read payments (they're public on blockchain anyway)
CREATE POLICY "zksend_payments_select" ON zksend_payments
  FOR SELECT
  USING (true);

-- Policy: Only authenticated users can insert (for tracking)
CREATE POLICY "zksend_payments_insert" ON zksend_payments
  FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- Policy: Only authenticated users can update
CREATE POLICY "zksend_payments_update" ON zksend_payments
  FOR UPDATE
  USING (auth.role() = 'authenticated');

-- Optional: Create a view for pending payments
CREATE OR REPLACE VIEW zksend_pending_payments AS
SELECT 
  id,
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

-- Grant access to view
GRANT SELECT ON zksend_pending_payments TO authenticated;
GRANT SELECT ON zksend_pending_payments TO anon;















