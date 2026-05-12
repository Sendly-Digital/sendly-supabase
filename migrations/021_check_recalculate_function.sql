-- Check if recalculate_leaderboard_stats function exists and is correct
-- This migration verifies that the function is properly set up

DO $$
BEGIN
  -- Check if function exists
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' 
    AND p.proname = 'recalculate_leaderboard_stats'
  ) THEN
    RAISE EXCEPTION 'Function recalculate_leaderboard_stats does not exist. Please apply migration 020_fix_recalculate_leaderboard_robust.sql first.';
  END IF;
  
  -- Check if safe_to_numeric function exists
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' 
    AND p.proname = 'safe_to_numeric'
  ) THEN
    RAISE EXCEPTION 'Function safe_to_numeric does not exist. Please apply migration 020_fix_recalculate_leaderboard_robust.sql first.';
  END IF;
  
  RAISE NOTICE 'All required functions exist. Leaderboard recalculation should work correctly.';
END $$;


















