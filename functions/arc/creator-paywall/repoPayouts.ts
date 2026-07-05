import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export type NormalizedReceipt = {
  kind: string;
  repo: string;
  recipient: string;
  prNumber: number | null;
  amount: string;
  status: string;
  paymentId: string | null;
  txHash: string | null;
  claimStatus: string;
  skipReason: string | null;
  createdAt: string;
  meta?: Record<string, unknown> | null;
};

/**
 * Union of hero merge payouts (github_pr_payouts, kind='merge') and the unified
 * ledger (github_payouts) into one normalized, chronologically sorted list.
 */
export async function listRepoPayouts(
  client: SupabaseClient,
  limit = 100,
): Promise<NormalizedReceipt[]> {
  const hero = await client
    .from('github_pr_payouts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  const generic = await client
    .from('github_payouts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  const out: NormalizedReceipt[] = [];

  if (!hero.error) {
    for (const r of hero.data ?? []) {
      out.push({
        kind: 'merge',
        repo: String(r.repo_full_name ?? ''),
        recipient: String(r.author_login ?? ''),
        prNumber: r.pr_number == null ? null : Number(r.pr_number),
        amount: String(r.amount_usdc ?? '0'),
        status: String(r.status ?? ''),
        paymentId: (r.payment_id as string | null) ?? null,
        txHash: (r.tx_hash as string | null) ?? null,
        claimStatus: String(r.claim_status ?? 'pending'),
        skipReason: (r.skip_reason as string | null) ?? null,
        createdAt: String(r.created_at ?? ''),
      });
    }
  }

  if (!generic.error) {
    for (const r of generic.data ?? []) {
      const meta = (r.meta as Record<string, unknown> | null) ?? null;
      const prFromMeta = meta && typeof meta.pr_number === 'number' ? (meta.pr_number as number) : null;
      out.push({
        kind: String(r.kind ?? ''),
        repo: String(r.repo_full_name ?? ''),
        recipient: String(r.recipient_login ?? ''),
        prNumber: prFromMeta,
        amount: String(r.amount_usdc ?? '0'),
        status: String(r.status ?? ''),
        paymentId: (r.payment_id as string | null) ?? null,
        txHash: (r.tx_hash as string | null) ?? null,
        claimStatus: String(r.claim_status ?? 'pending'),
        skipReason: (r.skip_reason as string | null) ?? null,
        createdAt: String(r.created_at ?? ''),
        meta,
      });
    }
  }

  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out.slice(0, limit);
}
