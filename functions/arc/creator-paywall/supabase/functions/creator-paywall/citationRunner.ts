import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { paySocialIdentity, type PrPayoutDeps } from './prPayout.ts';
import { listCitationSources, type CitationSourceRow } from './citationSources.ts';

export type CitationPaymentRecord = {
  sourceRef: string;
  slug: string;
  title: string;
  platform: string;
  handle: string;
  amountUsdc: number;
  paymentId: string;
  txHash: string;
  excerpt: string;
};

export type CitationRunResult = {
  question: string;
  answer: string;
  citations: CitationPaymentRecord[];
};

type PaywallRow = {
  slug: string;
  title: string;
  content_body: string;
  platform: string;
  handle: string;
  price_usdc: string;
  active: boolean;
};

async function loadPaywallSlug(
  client: SupabaseClient,
  slug: string,
): Promise<PaywallRow | null> {
  const { data, error } = await client
    .from('creator_paywalls')
    .select('slug, title, content_body, platform, handle, price_usdc, active')
    .eq('slug', slug)
    .eq('active', true)
    .maybeSingle();
  if (error) return null;
  return data as PaywallRow | null;
}

export async function runCitationDemo(
  deps: PrPayoutDeps,
  question: string,
): Promise<CitationRunResult> {
  const client = deps.getClient();
  const sources = await listCitationSources(client);
  const slugSources = sources.filter((s) => s.source_type === 'slug');

  if (!slugSources.length) {
    throw new Error('no_active_slug_sources');
  }

  const citations: CitationPaymentRecord[] = [];
  const excerpts: string[] = [];

  for (const source of slugSources.slice(0, 3)) {
    const paywall = await loadPaywallSlug(client, source.source_ref);
    if (!paywall) continue;

    const amountUsdc = parseFloat(String(paywall.price_usdc));
    const { paymentId, txHash } = await paySocialIdentity(
      deps,
      paywall.platform,
      paywall.handle,
      amountUsdc,
    );

    const excerpt = paywall.content_body.slice(0, 280).trim();
    excerpts.push(`[${paywall.title}](${source.source_ref}): ${excerpt}…`);
    citations.push({
      sourceRef: source.source_ref,
      slug: paywall.slug,
      title: paywall.title,
      platform: paywall.platform,
      handle: paywall.handle,
      amountUsdc,
      paymentId,
      txHash,
      excerpt,
    });
  }

  if (!citations.length) {
    throw new Error('no_paywalls_resolved_for_sources');
  }

  const answer =
    `Research answer for: "${question}"\n\n` +
    excerpts.map((e, i) => `${i + 1}. ${e}`).join('\n\n');

  return { question, answer, citations };
}

export async function seedCitationSourcesFromPaywalls(
  client: SupabaseClient,
  slugs: string[],
  generateIdentityHash: (platform: string, handle: string) => `0x${string}`,
): Promise<CitationSourceRow[]> {
  const out: CitationSourceRow[] = [];
  for (const slug of slugs) {
    const paywall = await loadPaywallSlug(client, slug);
    if (!paywall) continue;
    const { data, error } = await client
      .from('citation_sources')
      .upsert(
        {
          source_ref: slug,
          source_type: 'slug',
          platform: paywall.platform,
          handle: paywall.handle,
          identity_hash: generateIdentityHash(paywall.platform, paywall.handle),
          price_usdc: paywall.price_usdc,
          status: 'active',
        },
        { onConflict: 'source_ref' },
      )
      .select('*')
      .single();
    if (!error && data) out.push(data as CitationSourceRow);
  }
  return out;
}
