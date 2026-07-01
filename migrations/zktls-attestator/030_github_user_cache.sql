-- Cache for GitHub user profile (avatar, name) to reduce api.github.com calls
CREATE TABLE IF NOT EXISTS github_user_cache (
  login TEXT PRIMARY KEY,
  name TEXT,
  avatar_url TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_github_user_cache_updated_at
  ON github_user_cache(updated_at);

ALTER TABLE github_user_cache ENABLE ROW LEVEL SECURITY;

-- Anyone can read (anon/authenticated) for preview
CREATE POLICY "github_user_cache_select" ON github_user_cache
  FOR SELECT
  USING (true);

-- Only service_role can write (Edge Function uses SERVICE_ROLE_KEY)
CREATE POLICY "github_user_cache_insert" ON github_user_cache
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "github_user_cache_update" ON github_user_cache
  FOR UPDATE
  USING (auth.role() = 'service_role');
