-- Create developer_wallets table for storing Circle Developer-Controlled Wallets
CREATE TABLE IF NOT EXISTS developer_wallets (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL, -- Wallet address from MetaMask (normalized to lowercase)
  circle_wallet_id TEXT NOT NULL UNIQUE, -- Circle wallet ID
  circle_wallet_set_id TEXT, -- Circle wallet set ID (optional, for grouping)
  wallet_address TEXT NOT NULL, -- Blockchain address of the wallet
  blockchain TEXT NOT NULL DEFAULT 'ARC-TESTNET', -- Blockchain network
  account_type TEXT NOT NULL DEFAULT 'EOA' CHECK (account_type IN ('EOA', 'SCA')), -- Account type
  state TEXT NOT NULL DEFAULT 'LIVE' CHECK (state IN ('LIVE', 'FROZEN')), -- Wallet state
  custody_type TEXT NOT NULL DEFAULT 'DEVELOPER' CHECK (custody_type = 'DEVELOPER'), -- Always DEVELOPER for this table
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, blockchain) -- One wallet per user per blockchain
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_developer_wallets_user_id ON developer_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_developer_wallets_circle_wallet_id ON developer_wallets(circle_wallet_id);
CREATE INDEX IF NOT EXISTS idx_developer_wallets_wallet_address ON developer_wallets(wallet_address);
CREATE INDEX IF NOT EXISTS idx_developer_wallets_blockchain ON developer_wallets(blockchain);

-- Enable Row Level Security (RLS)
ALTER TABLE developer_wallets ENABLE ROW LEVEL SECURITY;

-- Create policy to allow users to read their own wallets
CREATE POLICY "Users can read their own developer wallets" ON developer_wallets
  FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = auth.uid()::text);

-- Create policy to allow users to insert their own wallets
CREATE POLICY "Users can insert their own developer wallets" ON developer_wallets
  FOR INSERT
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = auth.uid()::text);

-- Create policy to allow users to update their own wallets
CREATE POLICY "Users can update their own developer wallets" ON developer_wallets
  FOR UPDATE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = auth.uid()::text);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_developer_wallets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_developer_wallets_updated_at
  BEFORE UPDATE ON developer_wallets
  FOR EACH ROW
  EXECUTE FUNCTION update_developer_wallets_updated_at();

