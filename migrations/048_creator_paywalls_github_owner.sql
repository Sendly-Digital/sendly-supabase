-- Migrate creator paywalls from Privy owner to GitHub OAuth owner (zk host flow)

ALTER TABLE creator_paywalls ADD COLUMN IF NOT EXISTS owner_github_user_id BIGINT;
ALTER TABLE creator_paywalls ADD COLUMN IF NOT EXISTS owner_github_login TEXT;

ALTER TABLE creator_paywalls ALTER COLUMN owner_privy_user_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_creator_paywalls_github_owner
  ON creator_paywalls(owner_github_user_id);

-- New paywalls require GitHub owner (enforced in Edge Function; nullable for legacy rows)
COMMENT ON COLUMN creator_paywalls.owner_github_user_id IS 'GitHub numeric user id from OAuth token verify';
COMMENT ON COLUMN creator_paywalls.owner_github_login IS 'Normalized GitHub login at create time';
