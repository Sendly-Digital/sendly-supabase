-- gift_cards: add chain_id for multi-chain filtering (Base, Arc, etc.)
-- Apply in Supabase: SQL Editor → run, or `supabase db push`

ALTER TABLE public.gift_cards
  ADD COLUMN IF NOT EXISTS chain_id BIGINT;

-- Legacy rows (single-chain deploy): default to Arc testnet as in VITE_ARC_CHAIN_ID
UPDATE public.gift_cards
SET chain_id = 5042002
WHERE chain_id IS NULL;

ALTER TABLE public.gift_cards
  ALTER COLUMN chain_id SET NOT NULL,
  ALTER COLUMN chain_id SET DEFAULT 5042002;

-- Replace UNIQUE(token_id) with UNIQUE(chain_id, token_id)
ALTER TABLE public.gift_cards DROP CONSTRAINT IF EXISTS gift_cards_token_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gift_cards_chain_id_token_id_key'
  ) THEN
    ALTER TABLE public.gift_cards
      ADD CONSTRAINT gift_cards_chain_id_token_id_key UNIQUE (chain_id, token_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS gift_cards_chain_id_idx ON public.gift_cards (chain_id);
CREATE INDEX IF NOT EXISTS gift_cards_sender_chain_idx ON public.gift_cards (sender_address, chain_id);
CREATE INDEX IF NOT EXISTS gift_cards_recipient_chain_idx ON public.gift_cards (recipient_address, chain_id);

COMMENT ON COLUMN public.gift_cards.chain_id IS 'EVM chain id (e.g. 8453 Base, 5042002 Arc testnet)';
