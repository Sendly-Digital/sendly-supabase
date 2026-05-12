-- Add chain_id to leaderboard_stats_graph_true for multi-network support
-- Keeps ARC (5042002) as default for existing data

ALTER TABLE IF EXISTS leaderboard_stats_graph_true
ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 5042002;

-- Backfill safety (in case column existed nullable in some environments)
UPDATE leaderboard_stats_graph_true
SET chain_id = 5042002
WHERE chain_id IS NULL OR chain_id = 0;

-- Indexes for per-chain leaderboard queries
CREATE INDEX IF NOT EXISTS idx_leaderboard_stats_graph_true_chain_id_user_identifier
  ON leaderboard_stats_graph_true(chain_id, user_identifier);

CREATE INDEX IF NOT EXISTS idx_leaderboard_stats_graph_true_chain_id_sender_address
  ON leaderboard_stats_graph_true(chain_id, sender_address);

CREATE INDEX IF NOT EXISTS idx_leaderboard_stats_graph_true_chain_id_cards_amount
  ON leaderboard_stats_graph_true(chain_id, cards_sent_total DESC, amount_sent_total DESC);

-- Replace unique identity to include chain_id (token/user keys can repeat across chains)
DROP INDEX IF EXISTS leaderboard_stats_graph_true_unique_identity;

CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_stats_graph_true_unique_identity_with_chain
  ON leaderboard_stats_graph_true (chain_id, user_identifier, sender_address, social_platform);

COMMENT ON COLUMN leaderboard_stats_graph_true.chain_id IS 'Chain ID for per-network leaderboard separation (5042002 = ARC, 42431 = Tempo, 84532 = Base Sepolia)';

