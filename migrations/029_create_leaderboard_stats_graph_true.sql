-- Create leaderboard_stats_graph_true table with the same structure as leaderboard_stats
-- This table is created to allow easy switching of leaderboard to use different statistics table

CREATE TABLE IF NOT EXISTS leaderboard_stats_graph_true (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_identifier TEXT NOT NULL DEFAULT '',
  sender_address TEXT NOT NULL DEFAULT '',
  social_platform TEXT NOT NULL DEFAULT 'address',
  display_name TEXT,
  avatar_url TEXT,
  last_recipient TEXT,
  cards_sent_total INTEGER NOT NULL DEFAULT 0,
  amount_sent_total NUMERIC(30, 8) NOT NULL DEFAULT 0,
  amount_sent_by_currency JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sent_at TIMESTAMPTZ,
  zns_domain TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create unique index (same as leaderboard_stats)
CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_stats_graph_true_unique_identity
  ON leaderboard_stats_graph_true (user_identifier, sender_address, social_platform);

-- Create index for sorting (same as leaderboard_stats)
CREATE INDEX IF NOT EXISTS leaderboard_stats_graph_true_cards_idx
  ON leaderboard_stats_graph_true (cards_sent_total DESC, amount_sent_total DESC);

-- Create index for ZNS domain lookups (same as leaderboard_stats)
CREATE INDEX IF NOT EXISTS idx_leaderboard_stats_graph_true_zns_domain 
ON leaderboard_stats_graph_true (zns_domain) 
WHERE zns_domain IS NOT NULL;

-- Add comment
COMMENT ON TABLE leaderboard_stats_graph_true IS 'Leaderboard statistics table with same structure as leaderboard_stats for easy switching';
COMMENT ON COLUMN leaderboard_stats_graph_true.zns_domain IS 'ZNS (ZNS Connect Name Service) domain name for the sender address';

-- Enable Row Level Security (RLS) - same policies as leaderboard_stats
ALTER TABLE leaderboard_stats_graph_true ENABLE ROW LEVEL SECURITY;

-- Allow public read access to leaderboard_stats_graph_true (for displaying leaderboard)
DROP POLICY IF EXISTS "Anyone can read leaderboard stats graph true" ON leaderboard_stats_graph_true;
CREATE POLICY "Anyone can read leaderboard stats graph true" ON leaderboard_stats_graph_true
  FOR SELECT
  USING (true);

-- Deny public write access to leaderboard_stats_graph_true
-- Only Edge Functions with SERVICE_ROLE_KEY can insert/update/delete
DROP POLICY IF EXISTS "Deny public write access to leaderboard stats graph true" ON leaderboard_stats_graph_true;
CREATE POLICY "Deny public write access to leaderboard stats graph true" ON leaderboard_stats_graph_true
  FOR INSERT
  WITH CHECK (false);

DROP POLICY IF EXISTS "Deny public update access to leaderboard stats graph true" ON leaderboard_stats_graph_true;
CREATE POLICY "Deny public update access to leaderboard stats graph true" ON leaderboard_stats_graph_true
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "Deny public delete access to leaderboard stats graph true" ON leaderboard_stats_graph_true;
CREATE POLICY "Deny public delete access to leaderboard stats graph true" ON leaderboard_stats_graph_true
  FOR DELETE
  USING (false);









