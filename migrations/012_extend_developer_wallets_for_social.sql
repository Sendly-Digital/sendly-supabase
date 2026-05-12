-- Add new columns to support social accounts
ALTER TABLE developer_wallets 
  ADD COLUMN IF NOT EXISTS user_type TEXT DEFAULT 'wallet_address' 
    CHECK (user_type IN ('wallet_address', 'twitch_id', 'twitter_id', 'telegram_id', 'privy_id')),
  ADD COLUMN IF NOT EXISTS social_platform TEXT 
    CHECK (social_platform IN ('twitch', 'twitter', 'telegram', 'tiktok', 'instagram')),
  ADD COLUMN IF NOT EXISTS social_user_id TEXT,
  ADD COLUMN IF NOT EXISTS social_username TEXT,
  ADD COLUMN IF NOT EXISTS privy_user_id TEXT;

-- Update UNIQUE constraint
ALTER TABLE developer_wallets 
  DROP CONSTRAINT IF EXISTS developer_wallets_user_id_blockchain_key;

-- New UNIQUE constraints
ALTER TABLE developer_wallets 
  ADD CONSTRAINT developer_wallets_wallet_address_blockchain_unique 
    UNIQUE(wallet_address, blockchain);

-- One wallet per social account per blockchain
CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_wallets_social_unique 
  ON developer_wallets(social_platform, social_user_id, blockchain) 
  WHERE social_platform IS NOT NULL AND social_user_id IS NOT NULL;

-- One wallet per Privy ID per blockchain (for recovery)
CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_wallets_privy_unique 
  ON developer_wallets(privy_user_id, blockchain) 
  WHERE privy_user_id IS NOT NULL;

-- Indexes for fast search
CREATE INDEX IF NOT EXISTS idx_developer_wallets_social 
  ON developer_wallets(social_platform, social_user_id);
CREATE INDEX IF NOT EXISTS idx_developer_wallets_user_type 
  ON developer_wallets(user_type);
CREATE INDEX IF NOT EXISTS idx_developer_wallets_privy 
  ON developer_wallets(privy_user_id);

-- Update RLS policies to support social identifiers
DROP POLICY IF EXISTS "Users can read their own developer wallets" ON developer_wallets;
CREATE POLICY "Users can read their own developer wallets" ON developer_wallets
  FOR SELECT
  USING (
    user_id = current_setting('request.jwt.claims', true)::json->>'sub' 
    OR user_id = auth.uid()::text
    OR privy_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  );

-- Column comments
COMMENT ON COLUMN developer_wallets.user_type IS 'User identifier type: wallet_address, twitch_id, twitter_id, etc.';
COMMENT ON COLUMN developer_wallets.social_platform IS 'Social platform: twitch, twitter, telegram, etc.';
COMMENT ON COLUMN developer_wallets.social_user_id IS 'User ID in the social platform (e.g., Twitch ID)';
COMMENT ON COLUMN developer_wallets.social_username IS 'Username in the social platform';
COMMENT ON COLUMN developer_wallets.privy_user_id IS 'Privy user ID for access recovery';

