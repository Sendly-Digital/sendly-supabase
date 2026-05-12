-- Create telegram_contacts table for storing Telegram contact lists per user
CREATE TABLE IF NOT EXISTS telegram_contacts (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,
  phone_number TEXT,
  is_bot BOOLEAN,
  language_code TEXT,
  avatar_url TEXT,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_favorite BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id, telegram_user_id)
);

-- Indexes to speed up lookups and favorites filtering
CREATE INDEX IF NOT EXISTS idx_telegram_contacts_user_id ON telegram_contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_telegram_contacts_username ON telegram_contacts(username);
CREATE INDEX IF NOT EXISTS idx_telegram_contacts_display_name ON telegram_contacts(display_name);
CREATE INDEX IF NOT EXISTS idx_telegram_contacts_is_favorite ON telegram_contacts(user_id, is_favorite) WHERE is_favorite = TRUE;

-- Enable Row Level Security for telegram_contacts
ALTER TABLE telegram_contacts ENABLE ROW LEVEL SECURITY;

-- RLS policies mirroring other social contact tables
CREATE POLICY "Users can read their own telegram contacts" ON telegram_contacts
  FOR SELECT
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can insert their own telegram contacts" ON telegram_contacts
  FOR INSERT
  WITH CHECK (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can update their own telegram contacts" ON telegram_contacts
  FOR UPDATE
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Trigger to keep updated_at in sync
CREATE TRIGGER update_telegram_contacts_updated_at
  BEFORE UPDATE ON telegram_contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_social_contacts_updated_at();

COMMENT ON TABLE telegram_contacts IS 'Telegram contact list snapshots per wallet/user';
COMMENT ON COLUMN telegram_contacts.user_id IS 'Wallet address (lowercase) or alternate identifier used as foreign key';
COMMENT ON COLUMN telegram_contacts.telegram_user_id IS 'Telegram user ID for the contact';
COMMENT ON COLUMN telegram_contacts.display_name IS 'Convenience display name built from first/last name or username';

























