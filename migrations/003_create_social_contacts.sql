-- Create twitch_followed table for storing Twitch followed channels
CREATE TABLE IF NOT EXISTS twitch_followed (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  broadcaster_id TEXT NOT NULL,
  broadcaster_login TEXT NOT NULL,
  broadcaster_name TEXT NOT NULL,
  followed_at TIMESTAMP WITH TIME ZONE,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, broadcaster_id)
);

-- Create indexes for twitch_followed
CREATE INDEX IF NOT EXISTS idx_twitch_followed_user_id ON twitch_followed(user_id);
CREATE INDEX IF NOT EXISTS idx_twitch_followed_broadcaster_login ON twitch_followed(broadcaster_login);

-- Enable Row Level Security (RLS) for twitch_followed
ALTER TABLE twitch_followed ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for twitch_followed
CREATE POLICY "Users can read their own twitch contacts" ON twitch_followed
  FOR SELECT
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can insert their own twitch contacts" ON twitch_followed
  FOR INSERT
  WITH CHECK (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can update their own twitch contacts" ON twitch_followed
  FOR UPDATE
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Create twitter_followed table (preparation for future implementation)
CREATE TABLE IF NOT EXISTS twitter_followed (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  twitter_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  followed_at TIMESTAMP WITH TIME ZONE,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, twitter_user_id)
);

-- Create indexes for twitter_followed
CREATE INDEX IF NOT EXISTS idx_twitter_followed_user_id ON twitter_followed(user_id);
CREATE INDEX IF NOT EXISTS idx_twitter_followed_username ON twitter_followed(username);

-- Enable Row Level Security (RLS) for twitter_followed
ALTER TABLE twitter_followed ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for twitter_followed
CREATE POLICY "Users can read their own twitter contacts" ON twitter_followed
  FOR SELECT
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can insert their own twitter contacts" ON twitter_followed
  FOR INSERT
  WITH CHECK (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can update their own twitter contacts" ON twitter_followed
  FOR UPDATE
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Create tiktok_followed table (preparation for future implementation)
CREATE TABLE IF NOT EXISTS tiktok_followed (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  tiktok_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  followed_at TIMESTAMP WITH TIME ZONE,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, tiktok_user_id)
);

-- Create indexes for tiktok_followed
CREATE INDEX IF NOT EXISTS idx_tiktok_followed_user_id ON tiktok_followed(user_id);
CREATE INDEX IF NOT EXISTS idx_tiktok_followed_username ON tiktok_followed(username);

-- Enable Row Level Security (RLS) for tiktok_followed
ALTER TABLE tiktok_followed ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for tiktok_followed
CREATE POLICY "Users can read their own tiktok contacts" ON tiktok_followed
  FOR SELECT
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can insert their own tiktok contacts" ON tiktok_followed
  FOR INSERT
  WITH CHECK (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can update their own tiktok contacts" ON tiktok_followed
  FOR UPDATE
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Create instagram_followed table (preparation for future implementation)
CREATE TABLE IF NOT EXISTS instagram_followed (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  instagram_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  followed_at TIMESTAMP WITH TIME ZONE,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, instagram_user_id)
);

-- Create indexes for instagram_followed
CREATE INDEX IF NOT EXISTS idx_instagram_followed_user_id ON instagram_followed(user_id);
CREATE INDEX IF NOT EXISTS idx_instagram_followed_username ON instagram_followed(username);

-- Enable Row Level Security (RLS) for instagram_followed
ALTER TABLE instagram_followed ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for instagram_followed
CREATE POLICY "Users can read their own instagram contacts" ON instagram_followed
  FOR SELECT
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can insert their own instagram contacts" ON instagram_followed
  FOR INSERT
  WITH CHECK (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can update their own instagram contacts" ON instagram_followed
  FOR UPDATE
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_social_contacts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers to automatically update updated_at
CREATE TRIGGER update_twitch_followed_updated_at
  BEFORE UPDATE ON twitch_followed
  FOR EACH ROW
  EXECUTE FUNCTION update_social_contacts_updated_at();

CREATE TRIGGER update_twitter_followed_updated_at
  BEFORE UPDATE ON twitter_followed
  FOR EACH ROW
  EXECUTE FUNCTION update_social_contacts_updated_at();

CREATE TRIGGER update_tiktok_followed_updated_at
  BEFORE UPDATE ON tiktok_followed
  FOR EACH ROW
  EXECUTE FUNCTION update_social_contacts_updated_at();

CREATE TRIGGER update_instagram_followed_updated_at
  BEFORE UPDATE ON instagram_followed
  FOR EACH ROW
  EXECUTE FUNCTION update_social_contacts_updated_at();

