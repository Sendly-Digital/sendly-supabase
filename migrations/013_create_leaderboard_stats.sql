CREATE TABLE IF NOT EXISTS leaderboard_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_identifier TEXT NOT NULL DEFAULT '',
  sender_address TEXT NOT NULL DEFAULT '',
  social_platform TEXT NOT NULL DEFAULT 'generic',
  display_name TEXT,
  avatar_url TEXT,
  last_recipient TEXT,
  cards_sent_total INTEGER NOT NULL DEFAULT 0,
  amount_sent_total NUMERIC(30, 8) NOT NULL DEFAULT 0,
  amount_sent_by_currency JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_stats_unique_identity
  ON leaderboard_stats (user_identifier, sender_address, social_platform);

CREATE INDEX IF NOT EXISTS leaderboard_stats_cards_idx
  ON leaderboard_stats (cards_sent_total DESC, amount_sent_total DESC);

