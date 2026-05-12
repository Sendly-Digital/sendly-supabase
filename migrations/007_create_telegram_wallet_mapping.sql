-- Create table for Telegram wallet mapping
CREATE TABLE IF NOT EXISTS telegram_wallet_mapping (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL UNIQUE,
    wallet_address TEXT NOT NULL,
    verification_code TEXT,
    verified BOOLEAN DEFAULT FALSE,
    verification_signature TEXT,
    code_expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_telegram_wallet_telegram_id ON telegram_wallet_mapping(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_telegram_wallet_address ON telegram_wallet_mapping(wallet_address);
CREATE INDEX IF NOT EXISTS idx_telegram_wallet_verified ON telegram_wallet_mapping(telegram_user_id, verified) WHERE verified = TRUE;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_telegram_wallet_mapping_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER trigger_update_telegram_wallet_mapping_updated_at
    BEFORE UPDATE ON telegram_wallet_mapping
    FOR EACH ROW
    EXECUTE FUNCTION update_telegram_wallet_mapping_updated_at();

-- Enable RLS (Row Level Security)
ALTER TABLE telegram_wallet_mapping ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can read only their own records (if authenticated via Supabase Auth)
-- Note: Since we're using service_role key from bot, this policy is mainly for future use
CREATE POLICY "Users can read their own wallet mapping"
    ON telegram_wallet_mapping
    FOR SELECT
    USING (false); -- Disabled for now, as we use service_role key

-- RLS Policy: Service role can do everything (used by bot)
-- This is handled by using service_role key, so no explicit policy needed

-- Add comment to table
COMMENT ON TABLE telegram_wallet_mapping IS 'Maps Telegram user IDs to wallet addresses with verification';
COMMENT ON COLUMN telegram_wallet_mapping.telegram_user_id IS 'Telegram user ID (unique)';
COMMENT ON COLUMN telegram_wallet_mapping.wallet_address IS 'Ethereum wallet address (stored in lowercase)';
COMMENT ON COLUMN telegram_wallet_mapping.verification_code IS 'Temporary verification code (expires after 10 minutes)';
COMMENT ON COLUMN telegram_wallet_mapping.verified IS 'Whether the wallet link is verified';
COMMENT ON COLUMN telegram_wallet_mapping.verification_signature IS 'Optional signature for verification (future use)';
COMMENT ON COLUMN telegram_wallet_mapping.code_expires_at IS 'Expiration time for verification code';




























