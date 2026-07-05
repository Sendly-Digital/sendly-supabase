-- Lepton: GitHub repo payout scenarios (issue bounty, release dividend, review-to-earn)
-- Additive to 050 (hero merge payout stays on github_pr_payouts).

-- Unified ledger for non-hero payout kinds.
CREATE TABLE IF NOT EXISTS github_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  repo_id BIGINT NOT NULL,
  repo_full_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  recipient_login TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  amount_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing',
  payment_id TEXT,
  tx_hash TEXT,
  claim_status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  meta JSONB,
  CONSTRAINT github_payouts_dedupe_key UNIQUE (repo_id, kind, dedupe_key),
  CONSTRAINT github_payouts_kind_check CHECK (kind IN ('bounty', 'release', 'review')),
  CONSTRAINT github_payouts_status_check CHECK (
    status IN (
      'processing', 'paid', 'failed',
      'skipped_bot', 'skipped_self', 'skipped_budget',
      'skipped_no_policy', 'skipped_kind_disabled', 'skipped_duplicate',
      'skipped_ineligible'
    )
  ),
  CONSTRAINT github_payouts_claim_status_check CHECK (
    claim_status IN ('pending', 'claimed')
  )
);

CREATE INDEX IF NOT EXISTS idx_github_payouts_repo_kind
  ON github_payouts(repo_id, kind);

CREATE INDEX IF NOT EXISTS idx_github_payouts_created
  ON github_payouts(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_github_payouts_recipient
  ON github_payouts(recipient_login);

-- Issue -> bounty state (registered by label, resolved on merge).
CREATE TABLE IF NOT EXISTS issue_bounties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  repo_id BIGINT NOT NULL,
  repo_full_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  amount_usdc NUMERIC(18, 6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  labeled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  funded BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT issue_bounties_repo_issue_key UNIQUE (repo_id, issue_number),
  CONSTRAINT issue_bounties_status_check CHECK (status IN ('open', 'paid', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_issue_bounties_repo_issue
  ON issue_bounties(repo_id, issue_number);

-- Pending review escrow (settled on PR merge).
CREATE TABLE IF NOT EXISTS pr_reviews_escrow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  repo_id BIGINT NOT NULL,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  reviewer_login TEXT NOT NULL,
  state TEXT NOT NULL,
  body_len INTEGER NOT NULL DEFAULT 0,
  settled BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT pr_reviews_escrow_key UNIQUE (repo_id, pr_number, reviewer_login)
);

CREATE INDEX IF NOT EXISTS idx_pr_reviews_escrow_pr
  ON pr_reviews_escrow(repo_id, pr_number);

-- Per-kind policy fields (hero per_pr_amount_usdc untouched).
ALTER TABLE pr_payout_policies
  ADD COLUMN IF NOT EXISTS bounty_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS release_pool_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS split_mode TEXT NOT NULL DEFAULT 'equal',
  ADD COLUMN IF NOT EXISTS review_amount_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS review_min_chars INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS max_reviewers_per_pr INTEGER NOT NULL DEFAULT 2;

-- RLS: public read for receipts/proof; writes via service role only.
ALTER TABLE github_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_bounties ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_reviews_escrow ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "github_payouts_public_select" ON github_payouts;
CREATE POLICY "github_payouts_public_select"
  ON github_payouts FOR SELECT USING (true);

DROP POLICY IF EXISTS "issue_bounties_public_select" ON issue_bounties;
CREATE POLICY "issue_bounties_public_select"
  ON issue_bounties FOR SELECT USING (true);

COMMENT ON TABLE github_payouts IS 'Unified receipt log for bounty/release/review payout kinds';
COMMENT ON TABLE issue_bounties IS 'Issue bounties registered by label, resolved on merged PR';
COMMENT ON TABLE pr_reviews_escrow IS 'Pending review escrow settled when the reviewed PR merges';
