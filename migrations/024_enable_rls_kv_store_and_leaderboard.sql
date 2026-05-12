-- Enable Row Level Security (RLS) for kv_store_7b6d22fe
-- This table is only accessed through Edge Functions with SERVICE_ROLE_KEY
-- Public access should be completely blocked

ALTER TABLE kv_store_7b6d22fe ENABLE ROW LEVEL SECURITY;

-- Deny all public access to kv_store_7b6d22fe
-- Only SERVICE_ROLE_KEY (used in Edge Functions) can access this table
DROP POLICY IF EXISTS "Deny all public access to kv_store" ON kv_store_7b6d22fe;
CREATE POLICY "Deny all public access to kv_store" ON kv_store_7b6d22fe
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- Enable Row Level Security (RLS) for leaderboard_stats
-- This table is accessed through Edge Functions for writes, but should allow public reads
-- Public users can read leaderboard data, but cannot modify it

ALTER TABLE leaderboard_stats ENABLE ROW LEVEL SECURITY;

-- Allow public read access to leaderboard_stats (for displaying leaderboard)
DROP POLICY IF EXISTS "Anyone can read leaderboard stats" ON leaderboard_stats;
CREATE POLICY "Anyone can read leaderboard stats" ON leaderboard_stats
  FOR SELECT
  USING (true);

-- Deny public write access to leaderboard_stats
-- Only Edge Functions with SERVICE_ROLE_KEY can insert/update/delete
DROP POLICY IF EXISTS "Deny public write access to leaderboard stats" ON leaderboard_stats;
CREATE POLICY "Deny public write access to leaderboard stats" ON leaderboard_stats
  FOR INSERT
  WITH CHECK (false);

DROP POLICY IF EXISTS "Deny public update access to leaderboard stats" ON leaderboard_stats;
CREATE POLICY "Deny public update access to leaderboard stats" ON leaderboard_stats
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "Deny public delete access to leaderboard stats" ON leaderboard_stats;
CREATE POLICY "Deny public delete access to leaderboard stats" ON leaderboard_stats
  FOR DELETE
  USING (false);

-- Enable Row Level Security (RLS) for leaderboard_stats_duplicate
-- This table appears to be a duplicate/backup of leaderboard_stats
-- Apply the same security policies: allow public reads, deny public writes

ALTER TABLE leaderboard_stats_duplicate ENABLE ROW LEVEL SECURITY;

-- Allow public read access to leaderboard_stats_duplicate
DROP POLICY IF EXISTS "Anyone can read leaderboard stats duplicate" ON leaderboard_stats_duplicate;
CREATE POLICY "Anyone can read leaderboard stats duplicate" ON leaderboard_stats_duplicate
  FOR SELECT
  USING (true);

-- Deny public write access to leaderboard_stats_duplicate
-- Only Edge Functions with SERVICE_ROLE_KEY can insert/update/delete
DROP POLICY IF EXISTS "Deny public write access to leaderboard stats duplicate" ON leaderboard_stats_duplicate;
CREATE POLICY "Deny public write access to leaderboard stats duplicate" ON leaderboard_stats_duplicate
  FOR INSERT
  WITH CHECK (false);

DROP POLICY IF EXISTS "Deny public update access to leaderboard stats duplicate" ON leaderboard_stats_duplicate;
CREATE POLICY "Deny public update access to leaderboard stats duplicate" ON leaderboard_stats_duplicate
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "Deny public delete access to leaderboard stats duplicate" ON leaderboard_stats_duplicate;
CREATE POLICY "Deny public delete access to leaderboard stats duplicate" ON leaderboard_stats_duplicate
  FOR DELETE
  USING (false);

