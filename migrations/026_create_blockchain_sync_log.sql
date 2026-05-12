-- Table for logging blockchain event synchronization
-- Does NOT affect existing tables, used separately for tracking

CREATE TABLE IF NOT EXISTS blockchain_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'GiftCardCreated', 'GiftCardCreatedForTwitter', etc.
  sender_address TEXT NOT NULL,
  recipient_address TEXT,
  recipient_username TEXT,
  recipient_type TEXT, -- 'address', 'twitter', 'twitch', 'telegram', 'tiktok', 'instagram'
  amount TEXT NOT NULL,
  currency TEXT NOT NULL, -- 'USDC', 'EURC'
  message TEXT DEFAULT '',
  tx_hash TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  log_index INTEGER,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Additional event data
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for fast search
CREATE INDEX IF NOT EXISTS idx_blockchain_sync_log_token_id ON blockchain_sync_log(token_id);
CREATE INDEX IF NOT EXISTS idx_blockchain_sync_log_tx_hash ON blockchain_sync_log(tx_hash);
CREATE INDEX IF NOT EXISTS idx_blockchain_sync_log_sender ON blockchain_sync_log(sender_address);
CREATE INDEX IF NOT EXISTS idx_blockchain_sync_log_block_number ON blockchain_sync_log(block_number DESC);
CREATE INDEX IF NOT EXISTS idx_blockchain_sync_log_recipient_type ON blockchain_sync_log(recipient_type);
CREATE INDEX IF NOT EXISTS idx_blockchain_sync_log_synced_at ON blockchain_sync_log(synced_at DESC);

-- Unique index for events with log_index (primary case)
CREATE UNIQUE INDEX IF NOT EXISTS idx_blockchain_sync_log_unique_event 
  ON blockchain_sync_log(tx_hash, log_index) 
  WHERE log_index IS NOT NULL;

-- Additional index for searching by tx_hash (for events without log_index)
CREATE INDEX IF NOT EXISTS idx_blockchain_sync_log_tx_hash_log_index 
  ON blockchain_sync_log(tx_hash, log_index);

-- Index for combined search
CREATE INDEX IF NOT EXISTS idx_blockchain_sync_log_sender_token 
  ON blockchain_sync_log(sender_address, token_id);

-- Comments
COMMENT ON TABLE blockchain_sync_log IS 'Sync log of gift card creation events from the blockchain. Separate table, does not affect existing gift_cards and leaderboard_stats';
COMMENT ON COLUMN blockchain_sync_log.token_id IS 'Card ID from the event';
COMMENT ON COLUMN blockchain_sync_log.event_type IS 'Event type (GiftCardCreated, GiftCardCreatedForTwitter, etc.)';
COMMENT ON COLUMN blockchain_sync_log.synced_at IS 'Time when the event was synced to the DB';

-- Enable RLS for security
ALTER TABLE blockchain_sync_log ENABLE ROW LEVEL SECURITY;

-- Allow everyone to read (public blockchain data)
CREATE POLICY "Anyone can read blockchain sync log" ON blockchain_sync_log
  FOR SELECT
  USING (true);

-- Allow insert via service role (for Edge Functions)
-- This will be used via SERVICE_ROLE_KEY
COMMENT ON POLICY "Anyone can read blockchain sync log" ON blockchain_sync_log IS 'Allows reading sync logs for all users';
