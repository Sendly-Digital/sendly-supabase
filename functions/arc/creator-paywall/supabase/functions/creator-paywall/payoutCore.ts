import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export type PayoutKind = 'bounty' | 'release' | 'review';

export const KNOWN_BOTS = new Set([
  'dependabot[bot]',
  'dependabot-preview[bot]',
  'github-actions[bot]',
  'renovate[bot]',
]);

export function normalizeLogin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return v || null;
}

export function isBotLogin(login: string): boolean {
  return login.endsWith('[bot]') || KNOWN_BOTS.has(login);
}

export type CorePolicyRow = {
  id: string;
  repo_id: number;
  repo_full_name: string;
  per_pr_amount_usdc: string;
  daily_cap_usdc: string;
  budget_remaining_usdc: string;
  active: boolean;
  bounty_enabled: boolean;
  release_pool_usdc: string;
  split_mode: string;
  review_amount_usdc: string;
  review_min_chars: number;
  max_reviewers_per_pr: number;
};

export type CoreDeps = {
  getClient: () => SupabaseClient;
  generateIdentityHash: (platform: string, username: string) => `0x${string}`;
  pay: (platform: string, handle: string, amountUsdc: number) => Promise<{ paymentId: string; txHash: string }>;
};

export type SettleResult = {
  status: string;
  ledgerId?: string;
  skipReason?: string;
  paymentId?: string;
  txHash?: string;
};

export async function loadCorePolicy(
  client: SupabaseClient,
  repoId: number,
): Promise<CorePolicyRow | null> {
  const { data, error } = await client
    .from('pr_payout_policies')
    .select('*')
    .eq('repo_id', repoId)
    .maybeSingle();
  if (error) {
    console.error('[payout-core] policy load error:', error);
    return null;
  }
  return data as CorePolicyRow | null;
}

function startOfUtcDayIso(): string {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

export async function getDailyPaidTotalAllKinds(
  client: SupabaseClient,
  repoId: number,
): Promise<number> {
  const since = startOfUtcDayIso();
  let total = 0;

  const hero = await client
    .from('github_pr_payouts')
    .select('amount_usdc')
    .eq('repo_id', repoId)
    .eq('status', 'paid')
    .gte('created_at', since);
  if (!hero.error) {
    total += (hero.data ?? []).reduce((s, r) => s + parseFloat(String(r.amount_usdc)), 0);
  }

  const generic = await client
    .from('github_payouts')
    .select('amount_usdc')
    .eq('repo_id', repoId)
    .eq('status', 'paid')
    .gte('created_at', since);
  if (!generic.error) {
    total += (generic.data ?? []).reduce((s, r) => s + parseFloat(String(r.amount_usdc)), 0);
  }

  return total;
}

async function findExistingLedger(
  client: SupabaseClient,
  repoId: number,
  kind: PayoutKind,
  dedupeKey: string,
): Promise<{ id: string; status: string } | null> {
  const { data } = await client
    .from('github_payouts')
    .select('id, status')
    .eq('repo_id', repoId)
    .eq('kind', kind)
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();
  return (data as { id: string; status: string } | null) ?? null;
}

async function insertLedger(
  client: SupabaseClient,
  row: Record<string, unknown>,
): Promise<{ id: string } | null> {
  const { data, error } = await client.from('github_payouts').insert(row).select('id').single();
  if (error) {
    if (String(error.message).includes('duplicate') || error.code === '23505') return null;
    console.error('[payout-core] insert ledger error:', error);
    throw error;
  }
  return data as { id: string };
}

async function updateLedger(
  client: SupabaseClient,
  id: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from('github_payouts').update(updates).eq('id', id);
  if (error) console.error('[payout-core] update ledger error:', error);
}

async function debitBudget(
  client: SupabaseClient,
  policy: CorePolicyRow,
  amountUsdc: number,
): Promise<void> {
  const remaining = parseFloat(String(policy.budget_remaining_usdc));
  await client
    .from('pr_payout_policies')
    .update({
      budget_remaining_usdc: Math.max(0, remaining - amountUsdc),
      updated_at: new Date().toISOString(),
    })
    .eq('id', policy.id);
}

/**
 * Single funnel for every non-hero payout. Reserves the (repo, kind, dedupeKey)
 * ledger row, enforces bot/budget/daily-cap, then pays via deps.pay and records
 * the on-chain result. Idempotent by the unique ledger constraint.
 */
export async function settlePayout(
  deps: CoreDeps,
  params: {
    repoId: number;
    repoFullName: string;
    kind: PayoutKind;
    dedupeKey: string;
    login: string;
    amountUsdc: number;
    policy: CorePolicyRow;
    meta?: Record<string, unknown>;
  },
): Promise<SettleResult> {
  const client = deps.getClient();
  const { repoId, repoFullName, kind, dedupeKey, policy } = params;
  const login = normalizeLogin(params.login);
  const amountUsdc = params.amountUsdc;
  const meta = params.meta ?? {};

  if (!login) {
    return { status: 'skipped_ineligible', skipReason: 'no_recipient' };
  }

  const existing = await findExistingLedger(client, repoId, kind, dedupeKey);
  if (existing) {
    return { status: 'skipped_duplicate', ledgerId: existing.id };
  }

  const identityHash = deps.generateIdentityHash('github', login);
  const baseRow = {
    repo_id: repoId,
    repo_full_name: repoFullName,
    kind,
    dedupe_key: dedupeKey,
    recipient_login: login,
    identity_hash: identityHash,
    amount_usdc: amountUsdc,
    meta,
  };

  if (isBotLogin(login)) {
    const row = await insertLedger(client, {
      ...baseRow,
      status: 'skipped_bot',
      skip_reason: 'bot_recipient',
    });
    return { status: 'skipped_bot', ledgerId: row?.id, skipReason: 'bot_recipient' };
  }

  const dailyCap = parseFloat(String(policy.daily_cap_usdc));
  const budgetRemaining = parseFloat(String(policy.budget_remaining_usdc));
  const dailyPaid = await getDailyPaidTotalAllKinds(client, repoId);

  if (amountUsdc > budgetRemaining || dailyPaid + amountUsdc > dailyCap) {
    const row = await insertLedger(client, {
      ...baseRow,
      status: 'skipped_budget',
      skip_reason: 'budget_or_daily_cap',
    });
    return { status: 'skipped_budget', ledgerId: row?.id, skipReason: 'budget_or_daily_cap' };
  }

  const processing = await insertLedger(client, { ...baseRow, status: 'processing' });
  if (!processing) {
    return { status: 'skipped_duplicate' };
  }

  try {
    const { paymentId, txHash } = await deps.pay('github', login, amountUsdc);
    await updateLedger(client, processing.id, {
      status: 'paid',
      payment_id: paymentId,
      tx_hash: txHash,
      claim_status: 'pending',
    });
    await debitBudget(client, policy, amountUsdc);
    return { status: 'paid', ledgerId: processing.id, paymentId, txHash };
  } catch (err) {
    console.error(`[payout-core] payment failed (${kind}):`, err);
    await updateLedger(client, processing.id, {
      status: 'failed',
      skip_reason: err instanceof Error ? err.message : 'payment_failed',
    });
    return { status: 'failed', ledgerId: processing.id };
  }
}

/**
 * Authenticated GitHub REST GET. Requires GITHUB_API_TOKEN for private data and
 * higher rate limits (release compare uses this). Returns parsed JSON or null.
 */
export async function githubApiGet<T = unknown>(path: string): Promise<T | null> {
  const token = Deno.env.get('GITHUB_API_TOKEN')?.trim();
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sendly-repo-treasury',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn('[payout-core] github api get failed:', res.status, path);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error('[payout-core] github api get error:', err);
    return null;
  }
}
