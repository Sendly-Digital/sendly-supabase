-- Cache for Twitch user profile (avatar, display_name, followers) to reduce Helix API calls
CREATE TABLE IF NOT EXISTS twitch_user_cache (
  login TEXT PRIMARY KEY,
  display_name TEXT,
  profile_image_url TEXT,
  followers_total INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_twitch_user_cache_updated_at
  ON twitch_user_cache(updated_at);

ALTER TABLE twitch_user_cache ENABLE ROW LEVEL SECURITY;

-- Anyone can read (anon/authenticated) for preview
CREATE POLICY "twitch_user_cache_select" ON twitch_user_cache
  FOR SELECT
  USING (true);

-- Only service_role can write (Edge Function uses SERVICE_ROLE_KEY)
CREATE POLICY "twitch_user_cache_insert" ON twitch_user_cache
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "twitch_user_cache_update" ON twitch_user_cache
  FOR UPDATE
  USING (auth.role() = 'service_role');
