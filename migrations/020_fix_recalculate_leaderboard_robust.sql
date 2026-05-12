-- Fix recalculate_leaderboard_stats to be more robust
-- Fixes issues with temp table handling and error handling
-- Added proper validation for amount field and improved error handling

-- Helper function to safely convert text to numeric
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

CREATE OR REPLACE FUNCTION recalculate_leaderboard_stats()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Drop temp table if it exists (to ensure clean state)
  DROP TABLE IF EXISTS temp_zns_domains;
  
  -- Save existing ZNS domains before truncating (use DISTINCT ON to avoid duplicates)
  CREATE TEMP TABLE temp_zns_domains AS
  SELECT DISTINCT ON (LOWER(TRIM(sender_address)))
    LOWER(TRIM(sender_address)) AS sender_address, 
    zns_domain
  FROM leaderboard_stats
  WHERE zns_domain IS NOT NULL AND zns_domain != ''
  ORDER BY LOWER(TRIM(sender_address)), updated_at DESC;
  
  -- Delete all existing stats
  TRUNCATE TABLE leaderboard_stats;
  
  -- Recalculate from gift_cards
  INSERT INTO leaderboard_stats (
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
      created_at
    FROM gift_cards
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
      jsonb_object_agg(currency, currency_sum) AS amount_sent_by_currency
    FROM (
      SELECT
        sender_address,
        currency,
        SUM(amount) AS currency_sum
      FROM card_events
      GROUP BY sender_address, currency
    ) t
    GROUP BY sender_address
  ),
  last_activity AS (
    SELECT DISTINCT ON (sender_address)
      sender_address,
      recipient_username AS last_recipient,
      created_at AS last_sent_at
    FROM card_events
    ORDER BY sender_address, created_at DESC
  ),
  aggregated AS (
    SELECT
      sender_address,
      COUNT(*) AS cards_sent_total,
      SUM(amount) AS amount_sent_total
    FROM card_events
    GROUP BY sender_address
  )
  SELECT DISTINCT ON (a.sender_address)
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
    (SELECT zns_domain FROM temp_zns_domains tzd WHERE tzd.sender_address = a.sender_address LIMIT 1) AS zns_domain
  FROM aggregated a
  LEFT JOIN currency_totals ct ON ct.sender_address = a.sender_address
  LEFT JOIN last_activity la ON la.sender_address = a.sender_address
  ORDER BY a.sender_address;
  
  -- Update updated_at timestamp for all records (after INSERT)
  UPDATE leaderboard_stats
  SET updated_at = NOW()
  WHERE TRUE;
  
  -- Clean up temp table
  DROP TABLE IF EXISTS temp_zns_domains;
END;
$$;

