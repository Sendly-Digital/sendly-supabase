-- Function to update ZNS domain case-insensitively
CREATE OR REPLACE FUNCTION update_zns_domain_case_insensitive(
  p_address TEXT,
  p_domain TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  -- Update all rows where sender_address matches (case-insensitive)
  UPDATE leaderboard_stats
  SET zns_domain = p_domain,
      updated_at = NOW()
  WHERE LOWER(TRIM(sender_address)) = LOWER(TRIM(p_address));
  
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  
  -- Explicitly commit (though functions auto-commit)
  RETURN updated_count;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION update_zns_domain_case_insensitive(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION update_zns_domain_case_insensitive(TEXT, TEXT) TO anon;

