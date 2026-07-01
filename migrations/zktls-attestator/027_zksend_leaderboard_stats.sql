-- Table for pre-aggregated zkSEND leaderboard stats (fast reads at 10k+ users)
CREATE TABLE IF NOT EXISTS zksend_leaderboard_stats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  chain_id TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  social_platform TEXT NOT NULL,
  cards_sent_total BIGINT DEFAULT 0,
  amount_sent_total NUMERIC DEFAULT 0,
  amount_sent_by_currency JSONB DEFAULT '{}',
  last_sent_at TIMESTAMPTZ,
  last_recipient TEXT,
  display_name TEXT,
  avatar_url TEXT,
  zns_domain TEXT,
  UNIQUE (chain_id, contract_address, sender_address, social_platform)
);

CREATE INDEX IF NOT EXISTS idx_zksend_leaderboard_chain_contract
  ON zksend_leaderboard_stats(chain_id, contract_address);

ALTER TABLE zksend_leaderboard_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "zksend_leaderboard_stats_select" ON zksend_leaderboard_stats
  FOR SELECT
  USING (true);

-- Trigger function: upsert one row per (chain_id, contract_address, sender_address, social_platform)
CREATE OR REPLACE FUNCTION zksend_leaderboard_stats_upsert_on_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  amt NUMERIC;
  cur TEXT;
BEGIN
  amt := NULLIF(trim(NEW.amount), '')::numeric;
  IF amt IS NULL THEN
    amt := 0;
  END IF;
  cur := upper(trim(NEW.currency));
  IF cur = '' THEN
    cur := 'USDC';
  END IF;

  INSERT INTO zksend_leaderboard_stats (
    chain_id, contract_address, sender_address, social_platform,
    cards_sent_total, amount_sent_total, amount_sent_by_currency,
    last_sent_at, last_recipient
  )
  VALUES (
    NEW.chain_id,
    lower(trim(NEW.contract_address)),
    lower(trim(NEW.sender_address)),
    lower(trim(NEW.social_platform)),
    1,
    amt,
    jsonb_build_object(cur, amt),
    NEW.created_at,
    COALESCE(NEW.recipient_username, NEW.recipient_username_raw)
  )
  ON CONFLICT (chain_id, contract_address, sender_address, social_platform)
  DO UPDATE SET
    cards_sent_total = zksend_leaderboard_stats.cards_sent_total + 1,
    amount_sent_total = zksend_leaderboard_stats.amount_sent_total + amt,
    amount_sent_by_currency = jsonb_set(
      COALESCE(zksend_leaderboard_stats.amount_sent_by_currency, '{}'::jsonb),
      ARRAY[cur],
      to_jsonb((COALESCE((zksend_leaderboard_stats.amount_sent_by_currency ->> cur)::numeric, 0) + amt)::numeric)
    ),
    last_sent_at = GREATEST(zksend_leaderboard_stats.last_sent_at, COALESCE(NEW.created_at, '1970-01-01'::timestamptz)),
    last_recipient = CASE
      WHEN NEW.created_at IS NOT NULL AND (zksend_leaderboard_stats.last_sent_at IS NULL OR NEW.created_at >= zksend_leaderboard_stats.last_sent_at)
      THEN COALESCE(NEW.recipient_username, NEW.recipient_username_raw)
      ELSE zksend_leaderboard_stats.last_recipient
    END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zksend_leaderboard_stats_trigger ON zksend_payments;
CREATE TRIGGER zksend_leaderboard_stats_trigger
  AFTER INSERT ON zksend_payments
  FOR EACH ROW
  EXECUTE FUNCTION zksend_leaderboard_stats_upsert_on_payment();

-- Initial backfill from existing zksend_payments
WITH agg AS (
  SELECT
    chain_id,
    lower(trim(contract_address)) AS contract_address,
    lower(trim(sender_address)) AS sender_address,
    lower(trim(social_platform)) AS social_platform,
    count(*)::bigint AS cards_sent_total,
    sum(NULLIF(trim(amount), '')::numeric) AS amount_sent_total,
    max(created_at) AS last_sent_at
  FROM zksend_payments
  GROUP BY chain_id, lower(trim(contract_address)), lower(trim(sender_address)), lower(trim(social_platform))
),
by_currency AS (
  SELECT
    chain_id,
    lower(trim(contract_address)) AS contract_address,
    lower(trim(sender_address)) AS sender_address,
    lower(trim(social_platform)) AS social_platform,
    jsonb_object_agg(upper(trim(currency)), amt) AS amount_sent_by_currency
  FROM (
    SELECT
      chain_id,
      lower(trim(contract_address)) AS contract_address,
      lower(trim(sender_address)) AS sender_address,
      lower(trim(social_platform)) AS social_platform,
      upper(trim(currency)) AS currency,
      sum(NULLIF(trim(amount), '')::numeric) AS amt
    FROM zksend_payments
    GROUP BY chain_id, lower(trim(contract_address)), lower(trim(sender_address)), lower(trim(social_platform)), upper(trim(currency))
  ) t
  GROUP BY chain_id, lower(trim(contract_address)), lower(trim(sender_address)), lower(trim(social_platform))
),
last_rec AS (
  SELECT DISTINCT ON (chain_id, lower(trim(contract_address)), lower(trim(sender_address)), lower(trim(social_platform)))
    chain_id,
    lower(trim(contract_address)) AS contract_address,
    lower(trim(sender_address)) AS sender_address,
    lower(trim(social_platform)) AS social_platform,
    COALESCE(recipient_username, recipient_username_raw) AS last_recipient
  FROM zksend_payments
  ORDER BY chain_id, lower(trim(contract_address)), lower(trim(sender_address)), lower(trim(social_platform)), created_at DESC NULLS LAST
)
INSERT INTO zksend_leaderboard_stats (
  chain_id,
  contract_address,
  sender_address,
  social_platform,
  cards_sent_total,
  amount_sent_total,
  amount_sent_by_currency,
  last_sent_at,
  last_recipient
)
SELECT
  a.chain_id,
  a.contract_address,
  a.sender_address,
  a.social_platform,
  a.cards_sent_total,
  a.amount_sent_total,
  COALESCE(c.amount_sent_by_currency, '{}'::jsonb),
  a.last_sent_at,
  r.last_recipient
FROM agg a
LEFT JOIN by_currency c ON a.chain_id = c.chain_id AND a.contract_address = c.contract_address AND a.sender_address = c.sender_address AND a.social_platform = c.social_platform
LEFT JOIN last_rec r ON a.chain_id = r.chain_id AND a.contract_address = r.contract_address AND a.sender_address = r.sender_address AND a.social_platform = r.social_platform
ON CONFLICT (chain_id, contract_address, sender_address, social_platform) DO NOTHING;
