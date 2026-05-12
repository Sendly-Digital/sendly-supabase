-- Add zns_domain field to leaderboard_stats table
ALTER TABLE leaderboard_stats 
ADD COLUMN IF NOT EXISTS zns_domain TEXT;

-- Create index for faster lookups by ZNS domain
CREATE INDEX IF NOT EXISTS idx_leaderboard_stats_zns_domain 
ON leaderboard_stats (zns_domain) 
WHERE zns_domain IS NOT NULL;

-- Add comment
COMMENT ON COLUMN leaderboard_stats.zns_domain IS 'ZNS (ZNS Connect Name Service) domain name for the sender address';











































