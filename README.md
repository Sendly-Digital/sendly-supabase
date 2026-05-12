# sendly-supabase

Supabase backend for Sendly — NFT Gift Cards, zkTLS payments, leaderboard, and infrastructure.

## Project Structure

```
├── migrations/               # 46 SQL migration files
├── functions/
│   ├── _shared/
│   │   └── cors.ts           # Shared CORS middleware
│   ├── arc/
│   │   ├── server/
│   │   │   ├── index.tsx      # Main server: gift cards, leaderboard, social claims
│   │   │   ├── kv_store.tsx   # Key-value store wrapper
│   │   │   ├── gateway-balances/index.ts   # Circle USDC balances
│   │   │   ├── gateway-deposit/index.ts    # Circle USDC deposit
│   │   │   └── gateway-spend/index.ts      # Circle USDC spend
│   │   ├── zk-sender/
│   │   │   └── index.ts       # zkSEND/zksend payment & proof orchestration
│   │   └── old/               # Archived legacy functions
│   └── tempo/
│       ├── mpp-gateway/index.ts        # Paid MPP gateway (resolve, tip, zkTLS)
│       └── zk-sender-tempo/index.ts    # Tempo chain zk-sender variant
```

---

## Feature-to-File Mapping

### 1. NFT Gift Card

#### Scripts

| File | Purpose |
|---|---|
| `functions/arc/server/index.tsx` | All gift card routes: create, list, details, redeem, revoke, claim via Twitter/Twitch/Telegram/TikTok/Instagram |
| `functions/arc/server/kv_store.tsx` | KV store wrapper for card metadata (`kv_store_7b6d22fe`) |

#### SQL Migrations

| Migration | Description |
|---|---|
| `001_create_kv_store.sql` | Creates `kv_store_7b6d22fe` table |
| `002_create_gift_cards.sql` | Creates `gift_cards` table with RLS, indexes, triggers |
| `026_create_blockchain_sync_log.sql` | Creates `blockchain_sync_log` table |
| `035_add_chain_id_to_gift_cards.sql` | Adds `chain_id` column to `gift_cards` |
| `037_backfill_chain_id_arc.sql` | Backfills `chain_id = 5042002` (ARC) for existing rows |
| `039_add_chain_id_to_gift_cards_graph.sql` | Adds `chain_id` column to `gift_cards_graph` |
| `20250329130000_gift_cards_add_chain_id.sql` | Adds `chain_id` to `gift_cards` (timestamp-format migration) |

---

### 2. zkTLS Payment

#### Scripts

| File | Purpose |
|---|---|
| `functions/arc/zk-sender/index.ts` | zkSEND payment creation (`/payments`), claim (`/payments/:id/claim`), proof prep (`/proof/prepare-claim`), direct-send (`/direct-send/prepare`), social profile lookups |
| `functions/tempo/zk-sender-tempo/index.ts` | Tempo chain variant of zk-sender |
| `functions/tempo/mpp-gateway/index.ts` | Paid MPP gateway: resolve-zktls, prepare-claim-zktls, resolve, tip, bulk-tip |

#### SQL Migrations

| Migration | Description |
|---|---|
| `025_create_zksend_payments.sql` | Creates `zksend_payments` table |
| `042_create_mpp_paid_actions.sql` | Creates `mpp_paid_actions` table |
| `043_create_zktls_flow_events.sql` | Creates `zktls_flow_events` table |

---

### 3. Leaderboard

#### Scripts

| File | Purpose |
|---|---|
| `functions/arc/server/index.tsx` | Leaderboard routes: `/leaderboard/senders`, `/leaderboard/senders-graph`, recalculate, sync-from-subgraph, sync-graph, update-zns-domains, check-zns |

#### SQL Migrations

| Migration | Description |
|---|---|
| `013_create_leaderboard_stats.sql` | Creates `leaderboard_stats` table |
| `014_recalculate_leaderboard.sql` | Creates `recalculate_leaderboard_stats()` function |
| `015_migrate_missing_leaderboard_stats.sql` | Backfills missing leaderboard stats |
| `016_add_zns_domain_to_leaderboard_stats.sql` | Adds `zns_domain` column |
| `017_add_update_zns_domain_function.sql` | Creates `update_zns_domain_case_insensitive()` RPC |
| `018_fix_recalculate_leaderboard_preserve_zns.sql` | Fix: preserve ZNS domains on recalculate |
| `020_fix_recalculate_leaderboard_robust.sql` | Fix: robust recalculate with aggregate logic |
| `021_check_recalculate_function.sql` | Diagnostic: checks recalculate function state |
| `024_enable_rls_kv_store_and_leaderboard.sql` | Enables RLS on KV store and leaderboard tables |
| `029_create_leaderboard_stats_graph_true.sql` | Creates `leaderboard_stats_graph_true` table |
| `030_populate_leaderboard_stats_graph_true.sql` | Populates `graph_true` from `gift_cards_graph` |
| `031_recalculate_leaderboard_stats_graph_true.sql` | Creates `recalculate_leaderboard_stats_graph_true()` function |
| `032_fix_recalculate_leaderboard_stats_graph_true.sql` | Fixes the `graph_true` recalculate function |
| `033_diagnostic_gift_cards_graph.sql` | Diagnostic queries for `gift_cards_graph` |
| `034_convert_amount_to_usd.sql` | Converts amounts to USD representation |
| `036_add_chain_id_to_leaderboard_stats.sql` | Adds `chain_id` to `leaderboard_stats` |
| `038_add_chain_id_to_leaderboard_stats_graph_true.sql` | Adds `chain_id` to `leaderboard_stats_graph_true` |
| `044_recalculate_leaderboard_stats_graph_true_chain_id.sql` | Final recalculate with `chain_id` support |

---

### 4. Auxiliary / Infrastructure

#### Scripts

| File | Purpose |
|---|---|
| `functions/_shared/cors.ts` | Shared CORS middleware |
| `functions/arc/server/gateway-balances/index.ts` | Circle USDC balance queries |
| `functions/arc/server/gateway-deposit/index.ts` | Circle USDC deposit handling |
| `functions/arc/server/gateway-spend/index.ts` | Circle USDC spend handling |
| `functions/arc/old/sync-blockchain-events/index.ts` | Legacy blockchain event sync |
| `functions/arc/old/recalculate-leaderboard/index.ts` | Legacy leaderboard recalculate |

#### SQL Migrations (general infrastructure)

| Migration | Description |
|---|---|
| `003_create_social_contacts.sql` | Creates `social_contacts` table |
| `004_create_oauth_tokens.sql` | Creates `oauth_tokens` table |
| `005_create_developer_wallets.sql` | Creates `developer_wallets` table |
| `005_create_personal_contacts.sql` | Creates `personal_contacts` table |
| `006_add_favorite_to_contacts.sql` | Adds `favorite` flag to contacts |
| `007_create_telegram_wallet_mapping.sql` | Creates `telegram_wallet_mapping` table |
| `008_add_circle_wallet_id.sql` | Adds Circle `wallet_id` column |
| `009_add_telegram_user_id_to_developer_wallets.sql` | Adds `telegram_user_id` to `developer_wallets` |
| `010_create_telegram_contacts.sql` | Creates `telegram_contacts` table |
| `011_create_schedules.sql` | Creates `schedules` table |
| `012_extend_developer_wallets_for_social.sql` | Extends `developer_wallets` for social features |
| `019_create_feedback.sql` | Creates `feedback` table |
| `022_fix_feedback_rls.sql` | Fixes feedback RLS |
| `023_fix_feedback_rls_alternative.sql` | Alternative fix for feedback RLS |
| `20250329120000_directsend_deposits.sql` | DirectSend deposits table/update |

---

## Edge Function Endpoints

### ARC chain (`functions/arc/`)

#### Main Server (`server/index.tsx`)
| Method | Path | Feature |
|---|---|---|
| POST | `/gift-cards` | Create gift card |
| GET | `/gift-cards` | List user's cards |
| GET | `/gift-cards/:id` | Get card details |
| POST | `/gift-cards/:id/redeem` | Redeem a card |
| POST | `/gift-cards/:id/revoke` | Revoke active card |
| POST | `/gift-cards/twitter/create`, `/:username`, `/by-token/:id`, `/:id/claim` | Twitter gift cards |
| POST | `/gift-cards/twitch/*` | Twitch gift cards |
| POST | `/gift-cards/telegram/*` | Telegram gift cards |
| POST | `/gift-cards/tiktok/*` | TikTok gift cards |
| POST | `/gift-cards/instagram/*` | Instagram gift cards |
| GET | `/leaderboard/senders` | Main leaderboard |
| GET | `/leaderboard/senders-graph` | Graph-based leaderboard |
| POST | `/leaderboard/recalculate` | Recalculate `leaderboard_stats` |
| POST | `/leaderboard/recalculate-graph-true` | Recalculate `leaderboard_stats_graph_true` |
| POST | `/leaderboard/sync-from-subgraph` | Sync from subgraph (GraphQL) |
| POST | `/leaderboard/sync-graph` | Sync `graph_true` |
| POST | `/leaderboard/update-zns-domains` | Update ZNS domains |
| POST | `/leaderboard/update-zns-domains-graph` | Update ZNS domains (graph) |
| GET | `/leaderboard/check-zns/:address` | Check ZNS domain for address |

#### zk-Sender (`zk-sender/index.ts`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/payments` | Create zkSEND payment |
| PATCH | `/payments/:id/claim` | Mark payment as claimed |
| POST | `/proof/prepare-claim` | Prepare zkTLS claim proof |
| POST | `/direct-send/prepare` | Prepare wallet-to-wallet direct send |
| POST | `/wallets/send-transaction` | ABI-encoded contract calls |
| GET | `/twitter/user`, `/twitch/user`, `/github/user`, `/telegram/user` | Social profile lookups |