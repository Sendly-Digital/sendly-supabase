-- Add chain_id column to leaderboard_stats table
-- To support separate leaderboards for each network

-- Add chain_id column (integer, NOT NULL, default = ARC chainId = 5042002)
ALTER TABLE leaderboard_stats 
ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 5042002;

-- Create indexes to optimize queries with chain_id
CREATE INDEX IF NOT EXISTS idx_leaderboard_stats_chain_id_user_identifier 
  ON leaderboard_stats(chain_id, user_identifier);

CREATE INDEX IF NOT EXISTS idx_leaderboard_stats_chain_id_sender_address 
  ON leaderboard_stats(chain_id, sender_address);

-- Index for sorting leaderboard by network
CREATE INDEX IF NOT EXISTS idx_leaderboard_stats_chain_id_cards_amount 
  ON leaderboard_stats(chain_id, cards_sent_total DESC, amount_sent_total DESC);

-- Drop old unique index if exists
DROP INDEX IF EXISTS leaderboard_stats_unique_identity;

-- Create composite unique index with chain_id
CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_stats_unique_identity_with_chain
  ON leaderboard_stats (chain_id, user_identifier, sender_address, social_platform);

-- Column comment
COMMENT ON COLUMN leaderboard_stats.chain_id IS 'Chain ID of the network for separate leaderboard (5042002 = ARC, 42431 = Tempo, 84532 = Base Sepolia)';
