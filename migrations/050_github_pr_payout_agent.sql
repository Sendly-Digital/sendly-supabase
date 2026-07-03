-- Lepton: GitHub PR payout agent + citation source registry

CREATE TABLE IF NOT EXISTS pr_payout_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  repo_id BIGINT NOT NULL,
  repo_full_name TEXT NOT NULL,
  sponsor_pool_ref TEXT NOT NULL,
  per_pr_amount_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0.5,
  daily_cap_usdc NUMERIC(18, 6) NOT NULL DEFAULT 50,
  budget_remaining_usdc NUMERIC(18, 6) NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT pr_payout_policies_repo_id_key UNIQUE (repo_id)
);

CREATE INDEX IF NOT EXISTS idx_pr_payout_policies_repo_full_name
  ON pr_payout_policies(repo_full_name);

CREATE TABLE IF NOT EXISTS github_pr_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  repo_id BIGINT NOT NULL,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  author_login TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  amount_usdc NUMERIC(18, 6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  payment_id TEXT,
  tx_hash TEXT,
  claim_status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  merged_by_login TEXT,
  CONSTRAINT github_pr_payouts_repo_pr_key UNIQUE (repo_id, pr_number),
  CONSTRAINT github_pr_payouts_status_check CHECK (
    status IN (
      'processing', 'paid', 'failed',
      'skipped_bot', 'skipped_self_merge', 'skipped_budget',
      'skipped_no_policy', 'skipped_inactive', 'skipped_duplicate'
    )
  ),
  CONSTRAINT github_pr_payouts_claim_status_check CHECK (
    claim_status IN ('pending', 'claimed')
  )
);

CREATE INDEX IF NOT EXISTS idx_github_pr_payouts_repo_pr
  ON github_pr_payouts(repo_id, pr_number);

CREATE INDEX IF NOT EXISTS idx_github_pr_payouts_author
  ON github_pr_payouts(author_login);

CREATE INDEX IF NOT EXISTS idx_github_pr_payouts_created
  ON github_pr_payouts(created_at DESC);

CREATE TABLE IF NOT EXISTS citation_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_ref TEXT NOT NULL,
  source_type TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  price_usdc NUMERIC(18, 6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  CONSTRAINT citation_sources_source_ref_key UNIQUE (source_ref),
  CONSTRAINT citation_sources_source_type_check CHECK (source_type IN ('slug', 'url')),
  CONSTRAINT citation_sources_status_check CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS idx_citation_sources_source_ref
  ON citation_sources(source_ref);

CREATE INDEX IF NOT EXISTS idx_citation_sources_status
  ON citation_sources(status);

ALTER TABLE pr_payout_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_pr_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE citation_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pr_payout_policies_public_select" ON pr_payout_policies;
CREATE POLICY "pr_payout_policies_public_select"
  ON pr_payout_policies FOR SELECT USING (true);

DROP POLICY IF EXISTS "github_pr_payouts_public_select" ON github_pr_payouts;
CREATE POLICY "github_pr_payouts_public_select"
  ON github_pr_payouts FOR SELECT USING (true);

DROP POLICY IF EXISTS "citation_sources_public_select" ON citation_sources;
CREATE POLICY "citation_sources_public_select"
  ON citation_sources FOR SELECT USING (status = 'active');

COMMENT ON TABLE pr_payout_policies IS 'Repo policy for autonomous PR payouts (Lepton hero)';
COMMENT ON TABLE github_pr_payouts IS 'Receipt log for merged-PR payout events';
COMMENT ON TABLE citation_sources IS 'Registered sources for citation toll demo (slug or external URL)';
COMMENT ON COLUMN pr_payout_policies.sponsor_pool_ref IS 'Circle developer wallet id (PR_PAYOUT_SPONSOR_CIRCLE_WALLET_ID)';
