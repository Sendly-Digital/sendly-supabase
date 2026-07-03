import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export type CitationSourceRow = {
  id: string;
  created_at: string;
  source_ref: string;
  source_type: 'slug' | 'url';
  platform: string;
  handle: string;
  identity_hash: string;
  price_usdc: string;
  status: string;
};

function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!value || !/^[a-z0-9][a-z0-9/_-]*$/.test(value)) return null;
  return value;
}

function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value.startsWith('http://') && !value.startsWith('https://')) return null;
  return value;
}

export async function listCitationSources(client: SupabaseClient): Promise<CitationSourceRow[]> {
  const { data, error } = await client
    .from('citation_sources')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[citation] list error:', error);
    return [];
  }
  return (data ?? []) as CitationSourceRow[];
}

export async function registerCitationSource(
  client: SupabaseClient,
  input: {
    sourceRef: string;
    sourceType: 'slug' | 'url';
    platform: string;
    handle: string;
    identityHash: string;
    priceUsdc: number;
  },
): Promise<CitationSourceRow | null> {
  const { data, error } = await client
    .from('citation_sources')
    .upsert(
      {
        source_ref: input.sourceRef,
        source_type: input.sourceType,
        platform: input.platform,
        handle: input.handle,
        identity_hash: input.identityHash,
        price_usdc: input.priceUsdc,
        status: 'active',
      },
      { onConflict: 'source_ref' },
    )
    .select('*')
    .single();

  if (error) {
    console.error('[citation] register error:', error);
    return null;
  }
  return data as CitationSourceRow;
}

export async function registerCitationSourceFromBody(
  client: SupabaseClient,
  body: Record<string, unknown>,
  generateIdentityHash: (platform: string, handle: string) => `0x${string}`,
): Promise<{ source: CitationSourceRow | null; error?: string }> {
  const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : 'github';
  const handle =
    typeof body.handle === 'string' ? body.handle.trim().replace(/^@/, '').toLowerCase() : '';
  const slug = body.slug != null ? normalizeSlug(body.slug) : null;
  const url = body.url != null ? normalizeUrl(body.url) : null;
  const price = typeof body.priceUsdc === 'number'
    ? body.priceUsdc
    : parseFloat(String(body.priceUsdc ?? ''));

  if (!handle) return { source: null, error: 'invalid handle' };
  if (!Number.isFinite(price) || price < 0.5) return { source: null, error: 'price must be at least 0.5 USDC' };

  let sourceRef: string | null = null;
  let sourceType: 'slug' | 'url' | null = null;

  if (slug) {
    sourceRef = slug;
    sourceType = 'slug';
  } else if (url) {
    sourceRef = url;
    sourceType = 'url';
  } else if (typeof body.sourceRef === 'string') {
    sourceRef = body.sourceRef.trim();
    sourceType = sourceRef.startsWith('http') ? 'url' : 'slug';
  }

  if (!sourceRef || !sourceType) {
    return { source: null, error: 'provide slug or url as sourceRef' };
  }

  const source = await registerCitationSource(client, {
    sourceRef,
    sourceType,
    platform,
    handle,
    identityHash: generateIdentityHash(platform, handle),
    priceUsdc: price,
  });
  return { source };
}
