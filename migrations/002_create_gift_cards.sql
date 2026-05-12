-- Create gift_cards table for caching blockchain data
CREATE TABLE IF NOT EXISTS gift_cards (
  id BIGSERIAL PRIMARY KEY,
  token_id TEXT NOT NULL UNIQUE,
  sender_address TEXT NOT NULL,
  recipient_address TEXT,
  recipient_username TEXT,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('address', 'twitter', 'twitch', 'telegram', 'tiktok', 'instagram')),
  amount TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USDC', 'EURC')),
  message TEXT DEFAULT '',
  redeemed BOOLEAN DEFAULT FALSE,
  tx_hash TEXT,
  block_number BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_synced_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_gift_cards_sender ON gift_cards(sender_address);
CREATE INDEX IF NOT EXISTS idx_gift_cards_recipient_address ON gift_cards(recipient_address);
CREATE INDEX IF NOT EXISTS idx_gift_cards_recipient_username ON gift_cards(recipient_username);
CREATE INDEX IF NOT EXISTS idx_gift_cards_token_id ON gift_cards(token_id);
CREATE INDEX IF NOT EXISTS idx_gift_cards_created_at ON gift_cards(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gift_cards_redeemed ON gift_cards(redeemed);

-- Enable Row Level Security (RLS)
ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;

-- Create policy to allow anyone to read (for public blockchain data)
CREATE POLICY "Anyone can read gift cards" ON gift_cards
  FOR SELECT
  USING (true);

-- Create policy to allow anyone to insert (cards can be created by anyone)
CREATE POLICY "Anyone can insert gift cards" ON gift_cards
  FOR INSERT
  WITH CHECK (true);

-- Create policy to allow anyone to update (for syncing blockchain data)
CREATE POLICY "Anyone can update gift cards" ON gift_cards
  FOR UPDATE
  USING (true);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_gift_cards_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_gift_cards_updated_at
  BEFORE UPDATE ON gift_cards
  FOR EACH ROW
  EXECUTE FUNCTION update_gift_cards_updated_at();

