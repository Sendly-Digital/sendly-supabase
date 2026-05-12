-- Add telegram_user_id column to developer_wallets and supporting index
ALTER TABLE developer_wallets
  ADD COLUMN IF NOT EXISTS telegram_user_id TEXT;

-- Index for faster lookups by Telegram user ID
CREATE INDEX IF NOT EXISTS idx_developer_wallets_telegram_user_id
  ON developer_wallets(telegram_user_id);

-- Refresh updated_at trigger definition to ensure column changes propagate
DROP TRIGGER IF EXISTS update_developer_wallets_updated_at ON developer_wallets;

CREATE TRIGGER update_developer_wallets_updated_at
  BEFORE UPDATE ON developer_wallets
  FOR EACH ROW
  EXECUTE FUNCTION update_developer_wallets_updated_at();

