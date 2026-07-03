-- Creator profiles (Phase 1): first-class creator entity keyed by social identity.
-- Supports all 6 platforms (twitter, github, twitch, gmail, linkedin, telegram).

CREATE TABLE IF NOT EXISTS creator_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  display_name TEXT,
  bio TEXT,
  avatar_url TEXT,
  owner_github_user_id BIGINT,
  CONSTRAINT creator_profiles_platform_check
    CHECK (platform IN ('twitter', 'github', 'twitch', 'gmail', 'linkedin', 'telegram')),
  CONSTRAINT creator_profiles_platform_handle_key UNIQUE (platform, handle)
);

CREATE INDEX IF NOT EXISTS idx_creator_profiles_platform_handle
  ON creator_profiles(platform, handle);

CREATE INDEX IF NOT EXISTS idx_creator_profiles_github_owner
  ON creator_profiles(owner_github_user_id);

-- Widen paywall platform check from github-only to the 6 supported platforms
ALTER TABLE creator_paywalls DROP CONSTRAINT IF EXISTS creator_paywalls_platform_check;
ALTER TABLE creator_paywalls ADD CONSTRAINT creator_paywalls_platform_check
  CHECK (platform IN ('twitter', 'github', 'twitch', 'gmail', 'linkedin', 'telegram'));

-- Allow non-github articles: github owner columns become optional
ALTER TABLE creator_paywalls ALTER COLUMN owner_github_user_id DROP NOT NULL;
ALTER TABLE creator_paywalls ALTER COLUMN owner_github_login DROP NOT NULL;

-- Public read of profiles
ALTER TABLE creator_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "creator_profiles_public_select" ON creator_profiles;
CREATE POLICY "creator_profiles_public_select"
  ON creator_profiles
  FOR SELECT
  USING (true);

-- Backfill github profiles from existing paywalls (one row per distinct github login)
INSERT INTO creator_profiles (platform, handle, identity_hash, display_name, owner_github_user_id)
SELECT DISTINCT ON (p.handle)
  'github' AS platform,
  p.handle,
  p.identity_hash,
  p.owner_github_login AS display_name,
  p.owner_github_user_id
FROM creator_paywalls p
WHERE p.platform = 'github' AND p.handle IS NOT NULL
ON CONFLICT (platform, handle) DO NOTHING;

COMMENT ON TABLE creator_profiles IS 'Creator profile entity keyed by (platform, handle); Phase 1 of creator storage/profiles';
COMMENT ON COLUMN creator_profiles.identity_hash IS 'keccak256("platform:handle") - same hash used for ZkSend settlement';
COMMENT ON COLUMN creator_profiles.owner_github_user_id IS 'Set for github profiles verified via OAuth token; null for attested non-github profiles';
