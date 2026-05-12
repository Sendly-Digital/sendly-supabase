-- Convert amount field from smallest units (1000000 = 1 USDC/EURC/USYC) to USD/EUR (1 = 1 token)
-- This migration divides all amount values by 1000000 to convert from 6-decimal format
-- All supported tokens (USDC, EURC, USYC) use 6 decimals

-- Step 1: Check what we're working with (uncomment to run diagnostics)
/*
SELECT 
  COUNT(*) as total_rows,
  COUNT(CASE WHEN amount IS NOT NULL AND TRIM(amount) != '' THEN 1 END) as non_null_amounts,
  COUNT(CASE WHEN amount ~ '^[0-9]+\.?[0-9]*$' THEN 1 END) as valid_numeric_amounts,
  MIN(CASE WHEN amount ~ '^[0-9]+\.?[0-9]*$' THEN amount::numeric END) as min_amount, 
  MAX(CASE WHEN amount ~ '^[0-9]+\.?[0-9]*$' THEN amount::numeric END) as max_amount,
  AVG(CASE WHEN amount ~ '^[0-9]+\.?[0-9]*$' THEN amount::numeric END) as avg_amount,
  currency
FROM gift_cards_graph_duplicate 
WHERE amount IS NOT NULL AND amount != ''
GROUP BY currency;
*/

-- Step 2: Preview what will be changed (uncomment to preview)
/*
SELECT 
  id,
  token_id,
  amount as current_amount,
  currency,
  (amount::numeric / 1000000.0)::numeric as new_amount
FROM gift_cards_graph_duplicate
WHERE amount IS NOT NULL 
  AND TRIM(amount) != '' 
  AND amount ~ '^[0-9]+\.?[0-9]*$'
ORDER BY id DESC
LIMIT 20;
*/

-- Step 3: Update amount by dividing by 1000000
-- Convert TEXT to NUMERIC, divide by 1000000, then convert back to TEXT
-- Only updates rows where amount is a valid numeric value
-- 
-- IMPORTANT: This will convert ALL numeric values. If some values are already 
-- converted (less than 1000000), they will be divided again. 
-- Use the preview query above to check before running this update.
UPDATE gift_cards_graph_duplicate
SET amount = REGEXP_REPLACE(
    (amount::numeric / 1000000.0)::text,
    '\.?0+$',  -- Remove trailing zeros and optional dot
    ''
  ),
    updated_at = NOW()
WHERE amount IS NOT NULL 
  AND TRIM(amount) != '' 
  AND amount ~ '^[0-9]+\.?[0-9]*$';

-- Step 4: Verify the conversion (uncomment to check results)
/*
SELECT 
  id,
  token_id,
  amount as converted_amount,
  currency,
  updated_at
FROM gift_cards_graph_duplicate
WHERE amount IS NOT NULL
ORDER BY updated_at DESC, id DESC
LIMIT 20;
*/

-- Step 5: Check for any remaining large amounts (should be few or none)
/*
SELECT 
  COUNT(*) as remaining_large_amounts,
  MIN(amount::numeric) as min_amount,
  MAX(amount::numeric) as max_amount
FROM gift_cards_graph_duplicate
WHERE amount IS NOT NULL 
  AND TRIM(amount) != '' 
  AND amount ~ '^[0-9]+\.?[0-9]*$'
  AND amount::numeric > 100000;
*/

