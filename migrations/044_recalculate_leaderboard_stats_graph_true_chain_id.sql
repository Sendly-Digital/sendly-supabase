-- Chain-aware recalculate for leaderboard_stats_graph_true (promoted from 041_OLD_*).
-- Requires: gift_cards_graph.chain_id (039), leaderboard_stats_graph_true.chain_id (038).

CREATE OR REPLACE FUNCTION recalculate_leaderboard_stats_graph_true()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_total_source BIGINT;
BEGIN
  DROP TABLE IF EXISTS temp_zns_domains_graph_true;

  CREATE TEMP TABLE temp_zns_domains_graph_true AS
  SELECT DISTINCT ON (chain_id, LOWER(TRIM(sender_address)))
    chain_id,
    LOWER(TRIM(sender_address)) AS sender_address,
    zns_domain
  FROM leaderboard_stats_graph_true
  WHERE zns_domain IS NOT NULL AND zns_domain != ''
  ORDER BY chain_id, LOWER(TRIM(sender_address)), updated_at DESC;

  SELECT COUNT(*) INTO v_total_source FROM gift_cards_graph;
  RAISE NOTICE 'Total records in gift_cards_graph: %', v_total_source;

  TRUNCATE TABLE leaderboard_stats_graph_true;

  INSERT INTO leaderboard_stats_graph_true (
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
      COALESCE(UPPER(TRIM(NULLIF(currency, ''))), 'USDC') AS currency,
      recipient_username,
      CASE
        WHEN recipient_type IN ('twitter', 'twitch', 'telegram', 'tiktok', 'instagram')
        THEN recipient_type
        WHEN recipient_type IS NULL OR recipient_type = '' THEN 'address'
        ELSE 'address'
      END AS social_platform,
      CASE
        WHEN created_at IS NOT NULL THEN created_at
        WHEN block_timestamp IS NOT NULL THEN
          CASE
            WHEN block_timestamp < 10000000000 THEN TO_TIMESTAMP(block_timestamp)
            ELSE TO_TIMESTAMP(block_timestamp / 1000)
          END
        ELSE NOW()
      END AS created_at
    FROM gift_cards_graph
    WHERE
      chain_id IS NOT NULL
      AND chain_id > 0
      AND sender_address IS NOT NULL
      AND TRIM(sender_address) != ''
      AND LENGTH(TRIM(sender_address)) >= 10
      AND amount IS NOT NULL
      AND TRIM(amount) != ''
      AND safe_to_numeric(amount) > 0
  ),
  currency_totals AS (
    SELECT
      chain_id,
      sender_address,
      social_platform,
      jsonb_object_agg(currency, currency_sum) AS amount_sent_by_currency
    FROM (
      SELECT
        chain_id,
        sender_address,
        social_platform,
        currency,
        SUM(amount) AS currency_sum
      FROM card_events
      GROUP BY chain_id, sender_address, social_platform, currency
    ) t
    GROUP BY chain_id, sender_address, social_platform
  ),
  last_activity AS (
    SELECT DISTINCT ON (chain_id, sender_address, social_platform)
      chain_id,
      sender_address,
      social_platform,
      COALESCE(recipient_username, '') AS last_recipient,
      created_at AS last_sent_at
    FROM card_events
    ORDER BY chain_id, sender_address, social_platform, created_at DESC
  ),
  aggregated AS (
    SELECT
      chain_id,
      sender_address,
      social_platform,
      COUNT(*) AS cards_sent_total,
      SUM(amount) AS amount_sent_total
    FROM card_events
    GROUP BY chain_id, sender_address, social_platform
  )
  SELECT
    a.chain_id,
    a.sender_address AS user_identifier,
    a.sender_address,
    a.social_platform,
    a.cards_sent_total,
    a.amount_sent_total,
    COALESCE(ct.amount_sent_by_currency, '{}'::jsonb) AS amount_sent_by_currency,
    la.last_sent_at,
    la.last_recipient,
    NULL::text AS display_name,
    NULL::text AS avatar_url,
    (SELECT zns_domain FROM temp_zns_domains_graph_true tzd
      WHERE tzd.chain_id = a.chain_id AND tzd.sender_address = a.sender_address
      LIMIT 1
    ) AS zns_domain
  FROM aggregated a
  LEFT JOIN currency_totals ct
    ON ct.chain_id = a.chain_id AND ct.sender_address = a.sender_address AND ct.social_platform = a.social_platform
  LEFT JOIN last_activity la
    ON la.chain_id = a.chain_id AND la.sender_address = a.sender_address AND la.social_platform = a.social_platform
  ORDER BY a.chain_id, a.sender_address, a.social_platform;

  UPDATE leaderboard_stats_graph_true
  SET updated_at = NOW()
  WHERE TRUE;

  DROP TABLE IF EXISTS temp_zns_domains_graph_true;

  RAISE NOTICE 'Successfully recalculated leaderboard_stats_graph_true with % rows', (SELECT COUNT(*) FROM leaderboard_stats_graph_true);
END;
$$;
