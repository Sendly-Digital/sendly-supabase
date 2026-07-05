import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  type CoreDeps,
  type CorePolicyRow,
  normalizeLogin,
  settlePayout,
} from './payoutCore.ts';
import type { MergedPrPayload } from './bountyEscrow.ts';

export type GithubReviewPayload = {
  action?: string;
  review?: {
    state?: string;
    body?: string | null;
    user?: { login?: string };
  };
  pull_request?: {
    number?: number;
    user?: { login?: string };
  };
  repository?: { id?: number; full_name?: string };
};

function isMeaningfulReview(state: string, bodyLen: number, minChars: number): boolean {
  if (state === 'changes_requested') return true;
  // Text-length gate disabled: any approve counts regardless of comment length.
  // if (state === 'approved') return bodyLen >= minChars;
  if (state === 'approved') return true;
  return false;
}

/**
 * `pull_request_review` webhook: record a pending escrow row for meaningful
 * reviews. No payment happens until the PR merges.
 */
export async function recordReviewEscrow(
  client: SupabaseClient,
  policy: CorePolicyRow | null,
  payload: GithubReviewPayload,
): Promise<{ handled: boolean; status?: string }> {
  if (payload.action !== 'submitted') return { handled: false };

  const repoId = payload.repository?.id;
  const repoFullName = payload.repository?.full_name ?? '';
  const prNumber = payload.pull_request?.number;
  const reviewer = normalizeLogin(payload.review?.user?.login);
  const state = (payload.review?.state ?? '').toLowerCase();
  const bodyLen = typeof payload.review?.body === 'string' ? payload.review.body.trim().length : 0;
  const minChars = policy?.review_min_chars ?? 20;

  if (repoId == null || prNumber == null || !reviewer) return { handled: false };

  if (!isMeaningfulReview(state, bodyLen, minChars)) {
    return { handled: true, status: 'ignored_trivial' };
  }

  await client.from('pr_reviews_escrow').upsert(
    {
      repo_id: repoId,
      repo_full_name: repoFullName,
      pr_number: prNumber,
      reviewer_login: reviewer,
      state,
      body_len: bodyLen,
      settled: false,
    },
    { onConflict: 'repo_id,pr_number,reviewer_login' },
  );

  return { handled: true, status: 'escrowed' };
}

/**
 * On a merged PR, pay eligible reviewers (not the author), capped per policy.
 */
export async function settleReviewsOnMerge(
  deps: CoreDeps,
  policy: CorePolicyRow | null,
  payload: MergedPrPayload,
): Promise<{ handled: boolean; paid: number; results: string[] }> {
  const results: string[] = [];
  if (payload.action !== 'closed' || !payload.pull_request?.merged) {
    return { handled: false, paid: 0, results };
  }
  if (!policy || !policy.active) {
    return { handled: false, paid: 0, results: ['no_policy'] };
  }

  const client = deps.getClient();
  const repoId = payload.repository?.id;
  const repoFullName = payload.repository?.full_name ?? '';
  const prNumber = payload.pull_request?.number;
  const author = normalizeLogin(payload.pull_request?.user?.login);
  if (repoId == null || prNumber == null) return { handled: false, paid: 0, results };

  const amount = parseFloat(String(policy.review_amount_usdc ?? 0));
  if (!(amount > 0)) return { handled: true, paid: 0, results: ['review_amount_zero'] };

  const maxReviewers = policy.max_reviewers_per_pr ?? 2;

  const { data: rows } = await client
    .from('pr_reviews_escrow')
    .select('id, reviewer_login, settled')
    .eq('repo_id', repoId)
    .eq('pr_number', prNumber)
    .eq('settled', false)
    .order('created_at', { ascending: true });

  const eligible = (rows ?? [])
    .map((r) => r as { id: string; reviewer_login: string })
    .filter((r) => r.reviewer_login && r.reviewer_login !== author)
    .slice(0, maxReviewers);

  let paid = 0;
  for (const r of eligible) {
    const result = await settlePayout(deps, {
      repoId,
      repoFullName,
      kind: 'review',
      dedupeKey: `review:${prNumber}:${r.reviewer_login}`,
      login: r.reviewer_login,
      amountUsdc: amount,
      policy,
      meta: { pr_number: prNumber },
    });
    results.push(`${r.reviewer_login}:${result.status}`);
    if (result.status === 'paid' || result.status === 'skipped_duplicate') {
      await client
        .from('pr_reviews_escrow')
        .update({ settled: true })
        .eq('id', r.id);
    }
    if (result.status === 'paid') paid++;
  }

  return { handled: true, paid, results };
}
