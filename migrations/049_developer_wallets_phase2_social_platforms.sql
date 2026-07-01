-- Phase 2 zk OAuth: allow github, gmail, linkedin on developer_wallets
-- Edge function create-for-social inserts user_type as `{platform}_id`

ALTER TABLE developer_wallets
  DROP CONSTRAINT IF EXISTS developer_wallets_social_platform_check;

ALTER TABLE developer_wallets
  ADD CONSTRAINT developer_wallets_social_platform_check
  CHECK (
    social_platform IS NULL
    OR social_platform IN (
      'twitch',
      'twitter',
      'telegram',
      'tiktok',
      'instagram',
      'github',
      'gmail',
      'linkedin'
    )
  );

ALTER TABLE developer_wallets
  DROP CONSTRAINT IF EXISTS developer_wallets_user_type_check;

ALTER TABLE developer_wallets
  ADD CONSTRAINT developer_wallets_user_type_check
  CHECK (
    user_type IN (
      'wallet_address',
      'twitch_id',
      'twitter_id',
      'telegram_id',
      'tiktok_id',
      'instagram_id',
      'privy_id',
      'github_id',
      'gmail_id',
      'linkedin_id'
    )
  );

COMMENT ON COLUMN developer_wallets.social_platform IS
  'Social platform: twitch, twitter, telegram, tiktok, instagram, github, gmail, linkedin';
