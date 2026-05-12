-- Function to populate leaderboard_stats_graph_true from leaderboard_stats_graph
-- This function copies all data from leaderboard_stats_graph to leaderboard_stats_graph_true

CREATE OR REPLACE FUNCTION populate_leaderboard_stats_graph_true()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Clear existing data (optional - comment out if you want to merge instead)
  -- TRUNCATE TABLE leaderboard_stats_graph_true;
  
  -- Copy all data from leaderboard_stats_graph to leaderboard_stats_graph_true
  INSERT INTO leaderboard_stats_graph_true (
    user_identifier,
    sender_address,
    social_platform,
    display_name,
    avatar_url,
    last_recipient,
    cards_sent_total,
    amount_sent_total,
    amount_sent_by_currency,
    last_sent_at,
    zns_domain,
    created_at,
    updated_at
  )
  SELECT 
    user_identifier,
    sender_address,
    social_platform,
    display_name,
    avatar_url,
    last_recipient,
    cards_sent_total,
    amount_sent_total,
    amount_sent_by_currency,
    last_sent_at,
    zns_domain,
    created_at,
    updated_at
  FROM leaderboard_stats_graph
  ON CONFLICT (user_identifier, sender_address, social_platform) 
  DO UPDATE SET
    display_name = EXCLUDED.display_name,
    avatar_url = EXCLUDED.avatar_url,
    last_recipient = EXCLUDED.last_recipient,
    cards_sent_total = EXCLUDED.cards_sent_total,
    amount_sent_total = EXCLUDED.amount_sent_total,
    amount_sent_by_currency = EXCLUDED.amount_sent_by_currency,
    last_sent_at = EXCLUDED.last_sent_at,
    zns_domain = EXCLUDED.zns_domain,
    updated_at = NOW();
  
  RAISE NOTICE 'Successfully populated leaderboard_stats_graph_true with % rows', (SELECT COUNT(*) FROM leaderboard_stats_graph_true);
END;
$$;

-- Add comment
COMMENT ON FUNCTION populate_leaderboard_stats_graph_true() IS 'Populates leaderboard_stats_graph_true table with data from leaderboard_stats_graph';









