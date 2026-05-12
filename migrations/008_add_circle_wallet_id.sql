-- Add circle_wallet_id column to telegram_wallet_mapping table
-- This allows storing Circle Developer-Controlled Wallet ID instead of just MetaMask address

ALTER TABLE telegram_wallet_mapping 
ADD COLUMN IF NOT EXISTS circle_wallet_id TEXT;

-- Create index for circle_wallet_id
CREATE INDEX IF NOT EXISTS idx_telegram_wallet_circle_id ON telegram_wallet_mapping(circle_wallet_id);

-- Update comment
COMMENT ON COLUMN telegram_wallet_mapping.circle_wallet_id IS 'Circle Developer-Controlled Wallet ID (for server-managed wallets)';
COMMENT ON COLUMN telegram_wallet_mapping.wallet_address IS 'Wallet address (Circle wallet address or MetaMask address, stored in lowercase)';

-- Make wallet_address nullable since we can have Circle wallet without MetaMask address initially
ALTER TABLE telegram_wallet_mapping 
ALTER COLUMN wallet_address DROP NOT NULL;




























