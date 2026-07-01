-- Cache for Telegram user profile (avatar, name) to reduce MTProto resolveUsername calls
CREATE TABLE IF NOT EXISTS telegram_user_cache (
  username TEXT PRIMARY KEY,
  name TEXT,
  profile_image_url TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_user_cache_updated_at
  ON telegram_user_cache(updated_at);

ALTER TABLE telegram_user_cache ENABLE ROW LEVEL SECURITY;

-- Anyone can read (anon/authenticated) for preview
CREATE POLICY "telegram_user_cache_select" ON telegram_user_cache
  FOR SELECT
  USING (true);

-- Only service_role can write (Edge Function uses SERVICE_ROLE_KEY)
CREATE POLICY "telegram_user_cache_insert" ON telegram_user_cache
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "telegram_user_cache_update" ON telegram_user_cache
  FOR UPDATE
  USING (auth.role() = 'service_role');
