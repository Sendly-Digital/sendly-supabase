import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  type CoreDeps,
  type CorePolicyRow,
  isBotLogin,
  normalizeLogin,
  settlePayout,
} from './payoutCore.ts';

const BOUNTY_LABEL_RE = /^bounty[:\-]\s*(\d+(?:\.\d+)?)$/;
const CLOSES_ISSUE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

export type GithubIssuesPayload = {
  action?: string;
  issue?: { number?: number };
  label?: { name?: string };
  repository?: { id?: number; full_name?: string };
};

export type MergedPrPayload = {
  action?: string;
  pull_request?: {
    number?: number;
    merged?: boolean;
    merged_at?: string | null;
    body?: string | null;
    user?: { login?: string };
  };
  repository?: { id?: number; full_name?: string };
};

function parseBountyAmount(labelName: unknown): number | null {
  if (typeof labelName !== 'string') return null;
  const m = labelName.trim().toLowerCase().match(BOUNTY_LABEL_RE);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseClosedIssueNumbers(body: unknown): number[] {
  if (typeof body !== 'string' || !body) return [];
  const out = new Set<number>();
  for (const m of body.matchAll(CLOSES_ISSUE_RE)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) out.add(n);
  }
  return [...out];
}

/**
 * `issues` webhook: register a bounty when a `bounty:<amount>` label is added,
 * cancel it when the label is removed.
 */
export async function registerBountyFromLabel(
  client: SupabaseClient,
  payload: GithubIssuesPayload,
): Promise<{ handled: boolean; status?: string; issueNumber?: number; amount?: number }> {
  const action = payload.action;
  if (action !== 'labeled' && action !== 'unlabeled') return { handled: false };

  const repoId = payload.repository?.id;
  const repoFullName = payload.repository?.full_name ?? '';
  const issueNumber = payload.issue?.number;
  const amount = parseBountyAmount(payload.label?.name);

  if (repoId == null || issueNumber == null || amount == null) {
    return { handled: false };
  }

  const { data: existing } = await client
    .from('issue_bounties')
    .select('id, status')
    .eq('repo_id', repoId)
    .eq('issue_number', issueNumber)
    .maybeSingle();

  if (action === 'unlabeled') {
    if (existing && (existing as { status: string }).status === 'open') {
      await client
        .from('issue_bounties')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', (existing as { id: string }).id);
      return { handled: true, status: 'cancelled', issueNumber, amount };
    }
    return { handled: true, status: 'noop', issueNumber };
  }

  // labeled
  if (existing && (existing as { status: string }).status === 'paid') {
    return { handled: true, status: 'already_paid', issueNumber };
  }

  await client.from('issue_bounties').upsert(
    {
      repo_id: repoId,
      repo_full_name: repoFullName,
      issue_number: issueNumber,
      amount_usdc: amount,
      status: 'open',
      labeled_at: new Date().toISOString(),
      funded: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'repo_id,issue_number' },
  );

  return { handled: true, status: 'registered', issueNumber, amount };
}

/**
 * On a merged PR, pay open bounties for the issues it closes, provided the
 * bounty label existed before the PR merged.
 */
export async function resolveBountyOnMerge(
  deps: CoreDeps,
  policy: CorePolicyRow | null,
  payload: MergedPrPayload,
): Promise<{ handled: boolean; paid: number; results: string[] }> {
  const results: string[] = [];
  if (payload.action !== 'closed' || !payload.pull_request?.merged) {
    return { handled: false, paid: 0, results };
  }
  if (!policy || !policy.active || policy.bounty_enabled === false) {
    return { handled: false, paid: 0, results: ['bounty_disabled_or_no_policy'] };
  }

  const client = deps.getClient();
  const repoId = payload.repository?.id;
  const repoFullName = payload.repository?.full_name ?? '';
  const author = normalizeLogin(payload.pull_request?.user?.login);
  const mergedAt = payload.pull_request?.merged_at
    ? new Date(payload.pull_request.merged_at).getTime()
    : Date.now();
  const issueNumbers = parseClosedIssueNumbers(payload.pull_request?.body);

  if (repoId == null || !author || issueNumbers.length === 0) {
    return { handled: false, paid: 0, results };
  }

  let paid = 0;
  for (const issueNumber of issueNumbers) {
    const { data: bounty } = await client
      .from('issue_bounties')
      .select('id, amount_usdc, status, labeled_at')
      .eq('repo_id', repoId)
      .eq('issue_number', issueNumber)
      .maybeSingle();

    if (!bounty || (bounty as { status: string }).status !== 'open') continue;

    const labeledAt = new Date((bounty as { labeled_at: string }).labeled_at).getTime();
    if (labeledAt > mergedAt) {
      results.push(`issue#${issueNumber}:label_after_merge`);
      continue;
    }

    if (isBotLogin(author)) {
      results.push(`issue#${issueNumber}:bot_author`);
      continue;
    }

    const amount = parseFloat(String((bounty as { amount_usdc: string }).amount_usdc));
    const result = await settlePayout(deps, {
      repoId,
      repoFullName,
      kind: 'bounty',
      dedupeKey: `issue#${issueNumber}`,
      login: author,
      amountUsdc: amount,
      policy,
      meta: { issue_number: issueNumber, pr_number: payload.pull_request?.number },
    });

    results.push(`issue#${issueNumber}:${result.status}`);
    if (result.status === 'paid') {
      paid++;
      await client
        .from('issue_bounties')
        .update({ status: 'paid', updated_at: new Date().toISOString() })
        .eq('id', (bounty as { id: string }).id);
    }
  }

  return { handled: true, paid, results };
}
