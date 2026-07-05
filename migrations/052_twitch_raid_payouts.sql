-- Twitch Stream Treasury: Raid-to-Pay (Lepton vertical)

CREATE TABLE IF NOT EXISTS social_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  platform TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  handle TEXT,
  display_name TEXT,
  identity_hash TEXT NOT NULL,
  last_verified_at TIMESTAMPTZ,
  CONSTRAINT social_identities_platform_external_user_id_key UNIQUE (platform, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_social_identities_platform_external
  ON social_identities(platform, external_user_id);

CREATE INDEX IF NOT EXISTS idx_social_identities_identity_hash
  ON social_identities(identity_hash);

CREATE TABLE IF NOT EXISTS twitch_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sponsor_id TEXT NOT NULL,
  broadcaster_user_id TEXT NOT NULL,
  broadcaster_login_snapshot TEXT,
  name TEXT NOT NULL,
  total_budget_usdc NUMERIC(18, 6) NOT NULL,
  remaining_budget_usdc NUMERIC(18, 6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  sponsor_wallet_ref TEXT,
  CONSTRAINT twitch_campaigns_status_check CHECK (
    status IN ('draft', 'active', 'paused', 'ended')
  )
);

CREATE INDEX IF NOT EXISTS idx_twitch_campaigns_broadcaster
  ON twitch_campaigns(broadcaster_user_id);

CREATE INDEX IF NOT EXISTS idx_twitch_campaigns_status
  ON twitch_campaigns(status);

CREATE TABLE IF NOT EXISTS twitch_payout_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  campaign_id UUID NOT NULL REFERENCES twitch_campaigns(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL DEFAULT 'channel.raid',
  payout_kind TEXT NOT NULL DEFAULT 'raid',
  min_viewers INTEGER NOT NULL DEFAULT 1,
  rate_per_viewer_usdc NUMERIC(18, 6) NOT NULL,
  max_per_event_usdc NUMERIC(18, 6) NOT NULL,
  max_per_day_usdc NUMERIC(18, 6) NOT NULL DEFAULT 50,
  allowlist_json JSONB,
  require_approval BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT twitch_payout_policies_campaign_event_kind_key UNIQUE (campaign_id, event_type, payout_kind)
);

CREATE INDEX IF NOT EXISTS idx_twitch_payout_policies_campaign
  ON twitch_payout_policies(campaign_id);

CREATE TABLE IF NOT EXISTS twitch_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  campaign_id UUID NOT NULL REFERENCES twitch_campaigns(id),
  policy_id UUID NOT NULL REFERENCES twitch_payout_policies(id),
  payout_kind TEXT NOT NULL DEFAULT 'raid',
  event_type TEXT NOT NULL DEFAULT 'channel.raid',
  recipient_twitch_user_id TEXT NOT NULL,
  recipient_login_snapshot TEXT,
  identity_hash TEXT NOT NULL,
  amount_usdc NUMERIC(18, 6) NOT NULL,
  evidence_json JSONB,
  twitch_message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  payment_id TEXT,
  tx_hash TEXT,
  claim_status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  CONSTRAINT twitch_payouts_message_id_key UNIQUE (twitch_message_id),
  CONSTRAINT twitch_payouts_status_check CHECK (
    status IN (
      'processing', 'paid', 'failed',
      'skipped_ineligible', 'skipped_budget', 'skipped_duplicate',
      'skipped_self_raid', 'skipped_allowlist', 'skipped_daily_cap'
    )
  ),
  CONSTRAINT twitch_payouts_claim_status_check CHECK (
    claim_status IN ('pending', 'claimed')
  )
);

CREATE INDEX IF NOT EXISTS idx_twitch_payouts_campaign
  ON twitch_payouts(campaign_id);

CREATE INDEX IF NOT EXISTS idx_twitch_payouts_recipient
  ON twitch_payouts(recipient_twitch_user_id);

CREATE INDEX IF NOT EXISTS idx_twitch_payouts_created
  ON twitch_payouts(created_at DESC);

CREATE TABLE IF NOT EXISTS twitch_eventsub_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  subscription_id TEXT NOT NULL,
  type TEXT NOT NULL,
  version TEXT NOT NULL,
  condition JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  secret_ref TEXT NOT NULL,
  campaign_id UUID REFERENCES twitch_campaigns(id) ON DELETE SET NULL,
  CONSTRAINT twitch_eventsub_subscriptions_subscription_id_key UNIQUE (subscription_id),
  CONSTRAINT twitch_eventsub_subscriptions_status_check CHECK (
    status IN ('enabled', 'disabled', 'revoked')
  )
);

CREATE INDEX IF NOT EXISTS idx_twitch_eventsub_subscriptions_campaign
  ON twitch_eventsub_subscriptions(campaign_id);

CREATE TABLE IF NOT EXISTS twitch_eventsub_dedupe (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT twitch_eventsub_dedupe_message_id_key UNIQUE (message_id)
);

ALTER TABLE social_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE twitch_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE twitch_payout_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE twitch_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE twitch_eventsub_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE twitch_eventsub_dedupe ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "social_identities_public_select" ON social_identities;
CREATE POLICY "social_identities_public_select"
  ON social_identities FOR SELECT USING (true);

DROP POLICY IF EXISTS "twitch_campaigns_public_select" ON twitch_campaigns;
CREATE POLICY "twitch_campaigns_public_select"
  ON twitch_campaigns FOR SELECT USING (true);

DROP POLICY IF EXISTS "twitch_payout_policies_public_select" ON twitch_payout_policies;
CREATE POLICY "twitch_payout_policies_public_select"
  ON twitch_payout_policies FOR SELECT USING (true);

DROP POLICY IF EXISTS "twitch_payouts_public_select" ON twitch_payouts;
CREATE POLICY "twitch_payouts_public_select"
  ON twitch_payouts FOR SELECT USING (true);

DROP POLICY IF EXISTS "twitch_eventsub_subscriptions_public_select" ON twitch_eventsub_subscriptions;
CREATE POLICY "twitch_eventsub_subscriptions_public_select"
  ON twitch_eventsub_subscriptions FOR SELECT USING (true);

COMMENT ON TABLE social_identities IS 'Canonical social identity registry (twitch:uid:{id} hash)';
COMMENT ON TABLE twitch_campaigns IS 'Twitch Stream Treasury campaign (budget + broadcaster target)';
COMMENT ON TABLE twitch_payout_policies IS 'Event payout rules scoped to a Twitch campaign';
COMMENT ON TABLE twitch_payouts IS 'Raid payout receipt ledger';
COMMENT ON TABLE twitch_eventsub_subscriptions IS 'Managed EventSub subscriptions per campaign';
COMMENT ON TABLE twitch_eventsub_dedupe IS 'EventSub message-id dedupe layer';
