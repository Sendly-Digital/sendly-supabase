-- Persist Helix numeric user id so zk-sender /twitch/user can drive create-as-uid.
-- Existing rows stay nullable; cache hits without helix_id must refresh from Helix.

ALTER TABLE twitch_user_cache
  ADD COLUMN IF NOT EXISTS helix_id TEXT;

COMMENT ON COLUMN twitch_user_cache.helix_id IS 'Twitch Helix user id from GET /users; JSON field id on /zk-sender/twitch/user';
