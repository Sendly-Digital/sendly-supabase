-- Create personal_contacts table for storing manually added contacts
CREATE TABLE IF NOT EXISTS personal_contacts (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  wallet TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, wallet)
);

-- Create indexes for personal_contacts
CREATE INDEX IF NOT EXISTS idx_personal_contacts_user_id ON personal_contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_personal_contacts_wallet ON personal_contacts(wallet);

-- Enable Row Level Security (RLS) for personal_contacts
ALTER TABLE personal_contacts ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for personal_contacts
CREATE POLICY "Users can read their own personal contacts" ON personal_contacts
  FOR SELECT
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can insert their own personal contacts" ON personal_contacts
  FOR INSERT
  WITH CHECK (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can update their own personal contacts" ON personal_contacts
  FOR UPDATE
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can delete their own personal contacts" ON personal_contacts
  FOR DELETE
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_personal_contacts_updated_at
  BEFORE UPDATE ON personal_contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_social_contacts_updated_at();

