-- Diagnostic queries for gift_cards_graph table
-- Run these queries to understand why only 300 records are being created instead of 8000+

-- 1. Total count in gift_cards_graph
SELECT COUNT(*) as total_records FROM gift_cards_graph;

-- 2. Count by sender_address status
SELECT 
  CASE 
    WHEN sender_address IS NULL THEN 'NULL'
    WHEN TRIM(sender_address) = '' THEN 'EMPTY'
    WHEN LENGTH(TRIM(sender_address)) < 10 THEN 'TOO_SHORT'
    ELSE 'VALID'
  END as sender_status,
  COUNT(*) as count
FROM gift_cards_graph
GROUP BY sender_status
ORDER BY count DESC;

-- 3. Count by amount status
SELECT 
  CASE 
    WHEN amount IS NULL THEN 'NULL'
    WHEN TRIM(amount) = '' THEN 'EMPTY'
    WHEN TRIM(amount) ~ '^[0-9]+\.?[0-9]*$' = false THEN 'INVALID_FORMAT'
    ELSE 'VALID'
  END as amount_status,
  COUNT(*) as count
FROM gift_cards_graph
GROUP BY amount_status
ORDER BY count DESC;

-- 4. Count by currency status
SELECT 
  CASE 
    WHEN currency IS NULL THEN 'NULL'
    WHEN TRIM(currency) = '' THEN 'EMPTY'
    ELSE 'VALID'
  END as currency_status,
  COUNT(*) as count
FROM gift_cards_graph
GROUP BY currency_status
ORDER BY count DESC;

-- 5. Count of records that would pass all filters
SELECT COUNT(*) as records_passing_filters
FROM gift_cards_graph
WHERE 
  sender_address IS NOT NULL 
  AND TRIM(sender_address) != ''
  AND LENGTH(TRIM(sender_address)) >= 10
  AND amount IS NOT NULL 
  AND TRIM(amount) != ''
  AND currency IS NOT NULL;

-- 6. Sample of records that would be filtered out (limit 20)
SELECT 
  token_id,
  sender_address,
  amount,
  currency,
  recipient_type,
  CASE 
    WHEN sender_address IS NULL OR TRIM(sender_address) = '' THEN 'Missing sender'
    WHEN LENGTH(TRIM(sender_address)) < 10 THEN 'Sender too short'
    WHEN amount IS NULL OR TRIM(amount) = '' THEN 'Missing amount'
    WHEN currency IS NULL THEN 'Missing currency'
    ELSE 'Other'
  END as filter_reason
FROM gift_cards_graph
WHERE 
  sender_address IS NULL 
  OR TRIM(sender_address) = ''
  OR LENGTH(TRIM(sender_address)) < 10
  OR amount IS NULL 
  OR TRIM(amount) = ''
  OR currency IS NULL
LIMIT 20;

-- 7. Count unique (sender_address, recipient_type) combinations
SELECT 
  COUNT(DISTINCT (LOWER(TRIM(sender_address)), recipient_type)) as unique_combinations
FROM gift_cards_graph
WHERE 
  sender_address IS NOT NULL 
  AND TRIM(sender_address) != ''
  AND LENGTH(TRIM(sender_address)) >= 10
  AND amount IS NOT NULL 
  AND TRIM(amount) != ''
  AND currency IS NOT NULL;

-- 8. Distribution by recipient_type
SELECT 
  COALESCE(recipient_type, 'NULL') as recipient_type,
  COUNT(*) as count
FROM gift_cards_graph
WHERE 
  sender_address IS NOT NULL 
  AND TRIM(sender_address) != ''
  AND LENGTH(TRIM(sender_address)) >= 10
  AND amount IS NOT NULL 
  AND TRIM(amount) != ''
  AND currency IS NOT NULL
GROUP BY recipient_type
ORDER BY count DESC;

-- 9. Count of records with NULL sender_address (need to fill via /graph/fill-missing-senders)
SELECT COUNT(*) as records_needing_sender_address
FROM gift_cards_graph
WHERE (sender_address IS NULL OR TRIM(sender_address) = '')
  AND tx_hash IS NOT NULL;

-- 10. Check for potential grouping issues - count how many unique sender_address values exist
SELECT 
  COUNT(DISTINCT LOWER(TRIM(sender_address))) as unique_senders
FROM gift_cards_graph
WHERE 
  sender_address IS NOT NULL 
  AND TRIM(sender_address) != ''
  AND LENGTH(TRIM(sender_address)) >= 10;







