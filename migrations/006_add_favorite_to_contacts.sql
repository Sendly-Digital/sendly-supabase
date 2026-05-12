-- Add is_favorite column to all contact tables

-- Add is_favorite to personal_contacts
ALTER TABLE personal_contacts 
ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE;

-- Add is_favorite to twitch_followed
ALTER TABLE twitch_followed 
ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE;

-- Add is_favorite to twitter_followed
ALTER TABLE twitter_followed 
ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE;

-- Add is_favorite to tiktok_followed
ALTER TABLE tiktok_followed 
ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE;

-- Add is_favorite to instagram_followed
ALTER TABLE instagram_followed 
ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE;

-- Create indexes for is_favorite to improve query performance
CREATE INDEX IF NOT EXISTS idx_personal_contacts_is_favorite ON personal_contacts(user_id, is_favorite) WHERE is_favorite = TRUE;
CREATE INDEX IF NOT EXISTS idx_twitch_followed_is_favorite ON twitch_followed(user_id, is_favorite) WHERE is_favorite = TRUE;
CREATE INDEX IF NOT EXISTS idx_twitter_followed_is_favorite ON twitter_followed(user_id, is_favorite) WHERE is_favorite = TRUE;
CREATE INDEX IF NOT EXISTS idx_tiktok_followed_is_favorite ON tiktok_followed(user_id, is_favorite) WHERE is_favorite = TRUE;
CREATE INDEX IF NOT EXISTS idx_instagram_followed_is_favorite ON instagram_followed(user_id, is_favorite) WHERE is_favorite = TRUE;

