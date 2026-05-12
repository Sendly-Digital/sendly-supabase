-- DirectSend V2 escrow deposits (indexed from chain or written by Edge Function)
-- Apply in Supabase SQL editor or via supabase db push.

create table if not exists public.directsend_deposits (
  id uuid primary key default gen_random_uuid(),
  chain_id text not null,
  contract_address text not null,
  deposit_id text not null,
  sender_address text not null,
  recipient_wallet text not null,
  amount text not null,
  currency text not null,
  token_address text,
  tx_hash text,
  claimed boolean not null default false,
  claim_tx_hash text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (chain_id, contract_address, deposit_id)
);

create index if not exists directsend_deposits_recipient_idx
  on public.directsend_deposits (chain_id, contract_address, lower(recipient_wallet));

create index if not exists directsend_deposits_sender_idx
  on public.directsend_deposits (chain_id, lower(sender_address));

comment on table public.directsend_deposits is 'DirectSend V2 deposit records; optional mirror of on-chain state.';
