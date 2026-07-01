-- Creator paywalls for Social x402 (Arc ZkSend settlement)
CREATE TABLE IF NOT EXISTS creator_paywalls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  slug TEXT NOT NULL,
  owner_github_user_id BIGINT NOT NULL,
  owner_github_login TEXT NOT NULL,
  owner_privy_user_id TEXT,
  platform TEXT NOT NULL DEFAULT 'github',
  handle TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  price_usdc TEXT NOT NULL,
  title TEXT NOT NULL,
  content_body TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT creator_paywalls_slug_key UNIQUE (slug),
  CONSTRAINT creator_paywalls_platform_check CHECK (platform = 'github')
);

CREATE INDEX IF NOT EXISTS idx_creator_paywalls_owner_github
  ON creator_paywalls(owner_github_user_id);

CREATE INDEX IF NOT EXISTS idx_creator_paywalls_handle
  ON creator_paywalls(platform, handle);

CREATE TABLE IF NOT EXISTS creator_paywall_unlocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paywall_id UUID NOT NULL REFERENCES creator_paywalls(id) ON DELETE CASCADE,
  payment_id BIGINT NOT NULL,
  tx_hash TEXT,
  payer_address TEXT,
  source TEXT NOT NULL DEFAULT 'human',
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT creator_paywall_unlocks_paywall_payment_key UNIQUE (paywall_id, payment_id),
  CONSTRAINT creator_paywall_unlocks_source_check CHECK (source IN ('human', 'agent'))
);

CREATE INDEX IF NOT EXISTS idx_creator_paywall_unlocks_paywall
  ON creator_paywall_unlocks(paywall_id);

ALTER TABLE creator_paywalls ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_paywall_unlocks ENABLE ROW LEVEL SECURITY;

-- Public metadata (no content_body) for active paywalls
DROP POLICY IF EXISTS "creator_paywalls_public_select" ON creator_paywalls;
CREATE POLICY "creator_paywalls_public_select"
  ON creator_paywalls
  FOR SELECT
  USING (active = TRUE);

DROP POLICY IF EXISTS "creator_paywall_unlocks_public_select" ON creator_paywall_unlocks;
CREATE POLICY "creator_paywall_unlocks_public_select"
  ON creator_paywall_unlocks
  FOR SELECT
  USING (true);
