import {
  type CoreDeps,
  type CorePolicyRow,
  githubApiGet,
  isBotLogin,
  normalizeLogin,
  settlePayout,
} from './payoutCore.ts';

export type GithubReleasePayload = {
  action?: string;
  release?: { id?: number; tag_name?: string };
  repository?: { id?: number; full_name?: string };
};

type ReleaseListItem = { tag_name?: string; created_at?: string; draft?: boolean; prerelease?: boolean };
type CompareCommit = { author?: { login?: string } | null };
type CompareResponse = { commits?: CompareCommit[] };
type PullItem = { merged_at?: string | null; user?: { login?: string } };

function floorTo6(n: number): number {
  return Math.floor(n * 1_000_000) / 1_000_000;
}

/** Distinct, order-preserving, non-bot logins. */
function distinctAuthors(logins: (string | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of logins) {
    const login = normalizeLogin(raw);
    if (!login || isBotLogin(login) || seen.has(login)) continue;
    seen.add(login);
    out.push(login);
  }
  return out;
}

async function findPreviousTag(repoFullName: string, currentTag: string): Promise<string | null> {
  const releases = await githubApiGet<ReleaseListItem[]>(
    `/repos/${repoFullName}/releases?per_page=20`,
  );
  if (!releases?.length) return null;
  const idx = releases.findIndex((r) => r.tag_name === currentTag);
  const rest = idx >= 0 ? releases.slice(idx + 1) : releases;
  const prev = rest.find((r) => !r.draft && r.tag_name);
  return prev?.tag_name ?? null;
}

async function authorsFromCompare(
  repoFullName: string,
  prevTag: string,
  currTag: string,
): Promise<string[]> {
  const cmp = await githubApiGet<CompareResponse>(
    `/repos/${repoFullName}/compare/${encodeURIComponent(prevTag)}...${encodeURIComponent(currTag)}`,
  );
  if (!cmp?.commits?.length) return [];
  return distinctAuthors(cmp.commits.map((c) => c.author?.login ?? null));
}

async function authorsFallbackRecentMerged(repoFullName: string): Promise<string[]> {
  const pulls = await githubApiGet<PullItem[]>(
    `/repos/${repoFullName}/pulls?state=closed&per_page=30&sort=updated&direction=desc`,
  );
  if (!pulls?.length) return [];
  return distinctAuthors(pulls.filter((p) => p.merged_at).map((p) => p.user?.login ?? null));
}

/**
 * `release published` → split the release pool equally among distinct non-bot
 * PR authors included since the previous release. Idempotent per release id.
 */
export async function processReleaseDividend(
  deps: CoreDeps,
  policy: CorePolicyRow | null,
  payload: GithubReleasePayload,
): Promise<{ handled: boolean; paid: number; results: string[] }> {
  const results: string[] = [];
  if (payload.action !== 'published') return { handled: false, paid: 0, results };
  if (!policy || !policy.active) {
    return { handled: false, paid: 0, results: ['no_policy'] };
  }

  const pool = parseFloat(String(policy.release_pool_usdc ?? 0));
  if (!(pool > 0)) return { handled: true, paid: 0, results: ['release_pool_zero'] };

  const repoId = payload.repository?.id;
  const repoFullName = payload.repository?.full_name ?? '';
  const releaseId = payload.release?.id;
  const currentTag = payload.release?.tag_name ?? '';
  if (repoId == null || !repoFullName || releaseId == null || !currentTag) {
    return { handled: false, paid: 0, results: ['missing_release_fields'] };
  }

  const prevTag = await findPreviousTag(repoFullName, currentTag);
  let authors = prevTag ? await authorsFromCompare(repoFullName, prevTag, currentTag) : [];
  if (authors.length === 0) {
    authors = await authorsFallbackRecentMerged(repoFullName);
  }
  if (authors.length === 0) {
    return { handled: true, paid: 0, results: ['no_eligible_authors'] };
  }

  // Equal split: floor to 6 decimals, remainder to the first author.
  const n = authors.length;
  const per = floorTo6(pool / n);
  const remainder = floorTo6(pool - per * n);

  let paid = 0;
  for (let i = 0; i < authors.length; i++) {
    const login = authors[i];
    const amount = i === 0 ? floorTo6(per + remainder) : per;
    if (!(amount > 0)) {
      results.push(`${login}:zero_share`);
      continue;
    }
    const result = await settlePayout(deps, {
      repoId,
      repoFullName,
      kind: 'release',
      dedupeKey: `release:${releaseId}:${login}`,
      login,
      amountUsdc: amount,
      policy,
      meta: { release_id: releaseId, tag: currentTag, prev_tag: prevTag },
    });
    results.push(`${login}:${result.status}`);
    if (result.status === 'paid') paid++;
  }

  return { handled: true, paid, results };
}
