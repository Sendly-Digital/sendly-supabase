-- Function to recalculate leaderboard_stats_graph_true from gift_cards_graph
-- This function aggregates data from gift_cards_graph table into leaderboard_stats_graph_true
-- Similar to recalculate_leaderboard_stats() but works with gift_cards_graph instead of gift_cards

-- Helper function to safely convert text to numeric (reuse if exists, otherwise create)
CREATE OR REPLACE FUNCTION safe_to_numeric(val TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN val::numeric;
EXCEPTION
  WHEN OTHERS THEN
    RETURN 0::numeric;
END;
$$;

CREATE OR REPLACE FUNCTION recalculate_leaderboard_stats_graph_true()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Drop temp table if it exists (to ensure clean state)
  DROP TABLE IF EXISTS temp_zns_domains_graph_true;
  
  -- Save existing ZNS domains before truncating (use DISTINCT ON to avoid duplicates)
  CREATE TEMP TABLE temp_zns_domains_graph_true AS
  SELECT DISTINCT ON (LOWER(TRIM(sender_address)))
    LOWER(TRIM(sender_address)) AS sender_address, 
    zns_domain
  FROM leaderboard_stats_graph_true
  WHERE zns_domain IS NOT NULL AND zns_domain != ''
  ORDER BY LOWER(TRIM(sender_address)), updated_at DESC;
  
  -- Delete all existing stats
  TRUNCATE TABLE leaderboard_stats_graph_true;
  
  -- Recalculate from gift_cards_graph
  INSERT INTO leaderboard_stats_graph_true (
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
      LOWER(TRIM(sender_address)) AS sender_address,
      safe_to_numeric(amount) AS amount,
      currency,
      recipient_username,
      CASE 
        WHEN recipient_type IN ('twitter', 'twitch', 'telegram', 'tiktok', 'instagram') 
        THEN recipient_type
        ELSE 'address'
      END AS social_platform,
      CASE 
        WHEN created_at IS NOT NULL THEN created_at
        WHEN block_timestamp IS NOT NULL THEN TO_TIMESTAMP(block_timestamp)
        ELSE NOW()
      END AS created_at
    FROM gift_cards_graph
    WHERE sender_address IS NOT NULL 
      AND TRIM(sender_address) != ''
      AND LENGTH(TRIM(sender_address)) >= 10
      AND amount IS NOT NULL
      AND TRIM(amount) != ''
      AND currency IS NOT NULL
  ),
  currency_totals AS (
    SELECT
      sender_address,
      social_platform,
      jsonb_object_agg(currency, currency_sum) AS amount_sent_by_currency
    FROM (
      SELECT
        sender_address,
        social_platform,
        currency,
        SUM(amount) AS currency_sum
      FROM card_events
      GROUP BY sender_address, social_platform, currency
    ) t
    GROUP BY sender_address, social_platform
  ),
  last_activity AS (
    SELECT DISTINCT ON (sender_address, social_platform)
      sender_address,
      social_platform,
      COALESCE(recipient_username, '') AS last_recipient,
      created_at AS last_sent_at
    FROM card_events
    ORDER BY sender_address, social_platform, created_at DESC
  ),
  aggregated AS (
    SELECT
      sender_address,
      social_platform,
      COUNT(*) AS cards_sent_total,
      SUM(amount) AS amount_sent_total
    FROM card_events
    GROUP BY sender_address, social_platform
  )
  SELECT
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
    (SELECT zns_domain FROM temp_zns_domains_graph_true tzd WHERE tzd.sender_address = a.sender_address LIMIT 1) AS zns_domain
  FROM aggregated a
  LEFT JOIN currency_totals ct ON ct.sender_address = a.sender_address AND ct.social_platform = a.social_platform
  LEFT JOIN last_activity la ON la.sender_address = a.sender_address AND la.social_platform = a.social_platform
  ORDER BY a.sender_address, a.social_platform;
  
  -- Update updated_at timestamp for all records (after INSERT)
  UPDATE leaderboard_stats_graph_true
  SET updated_at = NOW()
  WHERE TRUE;
  
  -- Clean up temp table
  DROP TABLE IF EXISTS temp_zns_domains_graph_true;
  
  RAISE NOTICE 'Successfully recalculated leaderboard_stats_graph_true with % rows', (SELECT COUNT(*) FROM leaderboard_stats_graph_true);
END;
$$;

-- Add comment
COMMENT ON FUNCTION recalculate_leaderboard_stats_graph_true() IS 'Recalculates leaderboard_stats_graph_true table by aggregating data from gift_cards_graph table';

-- Grant execute permission
GRANT EXECUTE ON FUNCTION recalculate_leaderboard_stats_graph_true() TO authenticated;
GRANT EXECUTE ON FUNCTION recalculate_leaderboard_stats_graph_true() TO anon;

