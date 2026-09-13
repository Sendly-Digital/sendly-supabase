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

DROP POLICY IF EXISTS "telegram_user_cache_select" ON telegram_user_cache;
CREATE POLICY "telegram_user_cache_select" ON telegram_user_cache
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "telegram_user_cache_insert" ON telegram_user_cache;
CREATE POLICY "telegram_user_cache_insert" ON telegram_user_cache
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "telegram_user_cache_update" ON telegram_user_cache;
CREATE POLICY "telegram_user_cache_update" ON telegram_user_cache
  FOR UPDATE
  USING (auth.role() = 'service_role');
