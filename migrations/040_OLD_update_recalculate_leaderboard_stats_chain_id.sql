-- Update recalculate_leaderboard_stats() to be chain-aware
-- After adding chain_id to gift_cards and leaderboard_stats, we must aggregate per chain_id

CREATE OR REPLACE FUNCTION recalculate_leaderboard_stats()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Drop temp table if it exists (to ensure clean state)
  DROP TABLE IF EXISTS temp_zns_domains;

  -- Save existing ZNS domains before truncating (per chain_id + sender_address)
  CREATE TEMP TABLE temp_zns_domains AS
  SELECT DISTINCT ON (chain_id, LOWER(TRIM(sender_address)))
    chain_id,
    LOWER(TRIM(sender_address)) AS sender_address,
    zns_domain
  FROM leaderboard_stats
  WHERE zns_domain IS NOT NULL AND zns_domain != ''
  ORDER BY chain_id, LOWER(TRIM(sender_address)), updated_at DESC;

  -- Delete all existing stats
  TRUNCATE TABLE leaderboard_stats;

  -- Recalculate from gift_cards (per chain_id)
  INSERT INTO leaderboard_stats (
    chain_id,
    user_identifier,
    sender_address,
    social_platform,
    cards_sent_total,
    amount_sent_total,
    amount_sent_by_currency,
    last_sent_at,
    last_recipient,
    display_name,
    avatar_url,
    zns_domain
  )
  WITH card_events AS (
    SELECT
      chain_id,
      LOWER(TRIM(sender_address)) AS sender_address,
      safe_to_numeric(amount) AS amount,
      currency,
      recipient_username,
      created_at
    FROM gift_cards
    WHERE sender_address IS NOT NULL
      AND TRIM(sender_address) != ''
      AND LENGTH(TRIM(sender_address)) >= 10
      AND amount IS NOT NULL
      AND TRIM(amount) != ''
      AND currency IS NOT NULL
      AND chain_id IS NOT NULL
      AND chain_id > 0
  ),
  currency_totals AS (
    SELECT
      chain_id,
      sender_address,
      jsonb_object_agg(currency, currency_sum) AS amount_sent_by_currency
    FROM (
      SELECT
        chain_id,
        sender_address,
        currency,
        SUM(amount) AS currency_sum
      FROM card_events
      GROUP BY chain_id, sender_address, currency
    ) t
    GROUP BY chain_id, sender_address
  ),
  last_activity AS (
    SELECT DISTINCT ON (chain_id, sender_address)
      chain_id,
      sender_address,
      recipient_username AS last_recipient,
      created_at AS last_sent_at
    FROM card_events
    ORDER BY chain_id, sender_address, created_at DESC
  ),
  aggregated AS (
    SELECT
      chain_id,
      sender_address,
      COUNT(*) AS cards_sent_total,
      SUM(amount) AS amount_sent_total
    FROM card_events
    GROUP BY chain_id, sender_address
  )
  SELECT DISTINCT ON (a.chain_id, a.sender_address)
    a.chain_id,
    a.sender_address AS user_identifier,
    a.sender_address,
    'address' AS social_platform,
    a.cards_sent_total,
    a.amount_sent_total,
    COALESCE(ct.amount_sent_by_currency, '{}'::jsonb) AS amount_sent_by_currency,
    la.last_sent_at,
    la.last_recipient,
    NULL::text AS display_name,
    NULL::text AS avatar_url,
    (SELECT zns_domain FROM temp_zns_domains tzd
      WHERE tzd.chain_id = a.chain_id AND tzd.sender_address = a.sender_address
      LIMIT 1
    ) AS zns_domain
  FROM aggregated a
  LEFT JOIN currency_totals ct
    ON ct.chain_id = a.chain_id AND ct.sender_address = a.sender_address
  LEFT JOIN last_activity la
    ON la.chain_id = a.chain_id AND la.sender_address = a.sender_address
  ORDER BY a.chain_id, a.sender_address;

  -- Update updated_at timestamp for all records (after INSERT)
  UPDATE leaderboard_stats
  SET updated_at = NOW()
  WHERE TRUE;

  -- Clean up temp table
  DROP TABLE IF EXISTS temp_zns_domains;
END;
$$;

