-- Backfill: set chain_id = 5042002 (ARC) for all existing records
-- This migration is for existing data created before multi-chain support was added

-- Update gift_cards
UPDATE gift_cards 
SET chain_id = 5042002 
WHERE chain_id IS NULL OR chain_id = 0;

-- Update leaderboard_stats
UPDATE leaderboard_stats 
SET chain_id = 5042002 
WHERE chain_id IS NULL OR chain_id = 0;

-- Verify that all records have chain_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM gift_cards WHERE chain_id IS NULL OR chain_id = 0
  ) THEN
    RAISE EXCEPTION 'Some gift_cards still have NULL or 0 chain_id';
  END IF;
  
  IF EXISTS (
    SELECT 1 FROM leaderboard_stats WHERE chain_id IS NULL OR chain_id = 0
  ) THEN
    RAISE EXCEPTION 'Some leaderboard_stats still have NULL or 0 chain_id';
  END IF;
END $$;