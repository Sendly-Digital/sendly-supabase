-- Add chain_id column to gift_cards table
-- To support multi-chain (ARC, Tempo, Base)

-- Add chain_id column (integer, NOT NULL, default = ARC chainId = 5042002)
ALTER TABLE gift_cards 
ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 5042002;

-- Create indexes to optimize queries with chain_id
CREATE INDEX IF NOT EXISTS idx_gift_cards_chain_id_tx_hash 
  ON gift_cards(chain_id, tx_hash);

CREATE INDEX IF NOT EXISTS idx_gift_cards_chain_id_sender 
  ON gift_cards(chain_id, sender_address);

CREATE INDEX IF NOT EXISTS idx_gift_cards_chain_id_token_id 
  ON gift_cards(chain_id, token_id);

CREATE INDEX IF NOT EXISTS idx_gift_cards_chain_id_recipient_address 
  ON gift_cards(chain_id, recipient_address) 
  WHERE recipient_address IS NOT NULL;

-- Drop old unique index on token_id if exists
-- And create composite unique index with chain_id
DROP INDEX IF EXISTS gift_cards_token_id_key;

-- Create unique index on (chain_id, token_id) to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS gift_cards_chain_id_token_id_unique 
  ON gift_cards(chain_id, token_id);

-- Column comment
COMMENT ON COLUMN gift_cards.chain_id IS 'Chain ID of the network where the card was created (5042002 = ARC, 42431 = Tempo, 84532 = Base Sepolia)';
