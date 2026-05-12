-- gift_cards_graph: chain_id + composite uniqueness (align with app / gift_cards)
-- Run in Supabase SQL Editor or: supabase db push
-- After run: Settings → API → Reload schema (or wait) if PostgREST still caches old columns.

ALTER TABLE public.gift_cards_graph
  ADD COLUMN IF NOT EXISTS chain_id BIGINT;

UPDATE public.gift_cards_graph
SET chain_id = 5042002
WHERE chain_id IS NULL;

ALTER TABLE public.gift_cards_graph
  ALTER COLUMN chain_id SET NOT NULL,
  ALTER COLUMN chain_id SET DEFAULT 5042002;

CREATE INDEX IF NOT EXISTS idx_gift_cards_graph_chain_id_tx_hash
  ON public.gift_cards_graph (chain_id, tx_hash);

CREATE INDEX IF NOT EXISTS idx_gift_cards_graph_chain_id_sender
  ON public.gift_cards_graph (chain_id, sender_address);

CREATE INDEX IF NOT EXISTS idx_gift_cards_graph_chain_id_recipient
  ON public.gift_cards_graph (chain_id, recipient_address);

CREATE INDEX IF NOT EXISTS idx_gift_cards_graph_chain_token
  ON public.gift_cards_graph (chain_id, token_id);

-- Drop legacy global uniqueness on token_id (names vary by Postgres version / Supabase)
ALTER TABLE public.gift_cards_graph DROP CONSTRAINT IF EXISTS gift_cards_graph_token_id_key;
ALTER TABLE public.gift_cards_graph DROP CONSTRAINT IF EXISTS gift_cards_graph_token_id_unique;
DROP INDEX IF EXISTS gift_cards_graph_token_id_key;
DROP INDEX IF EXISTS gift_cards_graph_token_id_unique;

-- If this fails: duplicate (chain_id, token_id) rows exist — dedupe first.
CREATE UNIQUE INDEX IF NOT EXISTS gift_cards_graph_chain_id_token_id_unique
  ON public.gift_cards_graph (chain_id, token_id);

COMMENT ON COLUMN public.gift_cards_graph.chain_id IS 'EVM chain id (5042002 ARC, 8453 Base, etc.)';

