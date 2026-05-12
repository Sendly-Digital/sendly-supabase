-- Improved function to recalculate leaderboard_stats_graph_true from gift_cards_graph
-- This version has better error handling, diagnostics, and more flexible filters
-- Fixes issue where only 300 records are created instead of 8000+

-- Helper function to safely convert text to numeric (reuse if exists, otherwise create)
CREATE OR REPLACE FUNCTION safe_to_numeric(val TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
BEGIN
  IF val IS NULL OR TRIM(val) = '' THEN
    RETURN 0::numeric;
  END IF;
  RETURN val::numeric;
EXCEPTION
  WHEN OTHERS THEN
    RETURN 0::numeric;
END;
$$;

-- Note: safe_to_timestamp helper function removed - using direct CASE statement in CTE instead

-- Improved function with better filtering and diagnostics
CREATE OR REPLACE FUNCTION recalculate_leaderboard_stats_graph_true()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_total_source BIGINT;
  v_filtered_count BIGINT;
  v_inserted_count BIGINT;
  v_null_sender_count BIGINT;
  v_invalid_amount_count BIGINT;
  v_invalid_currency_count BIGINT;
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
  
  -- Count total records in source table and diagnostics
  SELECT COUNT(*) INTO v_total_source FROM gift_cards_graph;
  SELECT COUNT(*) INTO v_null_sender_count FROM gift_cards_graph 
    WHERE sender_address IS NULL OR TRIM(sender_address) = '';
  SELECT COUNT(*) INTO v_invalid_amount_count FROM gift_cards_graph 
    WHERE sender_address IS NOT NULL 
      AND TRIM(sender_address) != ''
      AND (amount IS NULL OR TRIM(amount) = '' OR safe_to_numeric(amount) <= 0);
  SELECT COUNT(*) INTO v_invalid_currency_count FROM gift_cards_graph 
    WHERE sender_address IS NOT NULL 
      AND TRIM(sender_address) != ''
      AND amount IS NOT NULL 
      AND TRIM(amount) != ''
      AND safe_to_numeric(amount) > 0
      AND (currency IS NULL OR TRIM(currency) = '');
  
  RAISE NOTICE '=== DIAGNOSTICS ===';
  RAISE NOTICE 'Total records in gift_cards_graph: %', v_total_source;
  RAISE NOTICE 'Records with NULL/empty sender_address: %', v_null_sender_count;
  RAISE NOTICE 'Records with invalid amount: %', v_invalid_amount_count;
  RAISE NOTICE 'Records with invalid currency: %', v_invalid_currency_count;
  
  -- Delete all existing stats
  TRUNCATE TABLE leaderboard_stats_graph_true;
  
  -- Recalculate from gift_cards_graph with improved filtering
  -- Changed: More lenient filtering - check for valid address format (0x + hex), but allow shorter addresses too
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
      -- More lenient filtering - only exclude truly invalid records
      sender_address IS NOT NULL 
      AND TRIM(sender_address) != ''
      -- Allow addresses of any reasonable length (not just 42 chars)
      -- Ethereum addresses are typically 42 chars (0x + 40 hex), but allow shorter for compatibility
      AND LENGTH(TRIM(sender_address)) >= 10
      AND amount IS NOT NULL 
      AND TRIM(amount) != ''
      AND safe_to_numeric(amount) > 0  -- Only include records with valid positive amounts
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
  
  -- Get counts after insert
  SELECT COUNT(*) INTO v_filtered_count FROM gift_cards_graph
  WHERE sender_address IS NOT NULL 
    AND TRIM(sender_address) != ''
    AND LENGTH(TRIM(sender_address)) >= 10
    AND amount IS NOT NULL 
    AND TRIM(amount) != ''
    AND safe_to_numeric(amount) > 0;
  
  SELECT COUNT(*) INTO v_inserted_count FROM leaderboard_stats_graph_true;
  
  -- Update updated_at timestamp for all records (after INSERT)
  UPDATE leaderboard_stats_graph_true
  SET updated_at = NOW()
  WHERE TRUE;
  
  -- Clean up temp table
  DROP TABLE IF EXISTS temp_zns_domains_graph_true;
  
  RAISE NOTICE '=== RESULTS ===';
  RAISE NOTICE 'Records that passed filters: %', v_filtered_count;
  RAISE NOTICE 'Records inserted into leaderboard_stats_graph_true: %', v_inserted_count;
  RAISE NOTICE 'Unique (sender_address, social_platform) combinations: %', v_inserted_count;
  RAISE NOTICE 'Successfully recalculated leaderboard_stats_graph_true';
  
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in recalculate_leaderboard_stats_graph_true: %', SQLERRM;
    RAISE;
END;
$$;

-- Add comment
COMMENT ON FUNCTION recalculate_leaderboard_stats_graph_true() IS 'Recalculates leaderboard_stats_graph_true table by aggregating data from gift_cards_graph table. Returns diagnostic information.';

-- Grant execute permission
GRANT EXECUTE ON FUNCTION recalculate_leaderboard_stats_graph_true() TO authenticated;
GRANT EXECUTE ON FUNCTION recalculate_leaderboard_stats_graph_true() TO anon;

