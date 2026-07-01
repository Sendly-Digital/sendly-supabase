import { Hono } from 'npm:hono';
import { cors } from 'npm:hono/cors';
import { logger } from 'npm:hono/logger';
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  createPublicClient,
  http,
  keccak256,
  toBytes,
  type Address,
} from 'npm:viem';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-sendly-payment-id, x-sendly-tx-hash, x-sendly-source',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, PATCH, DELETE',
  'Access-Control-Max-Age': '86400',
};

const app = new Hono().basePath('/creator-paywall');

app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'x-client-info',
      'apikey',
      'X-Sendly-Payment-Id',
      'X-Sendly-Tx-Hash',
      'X-Sendly-Source',
    ],
    allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
    credentials: false,
    maxAge: 86400,
    exposeHeaders: ['Content-Length', 'Content-Type', 'WWW-Authenticate'],
  }),
);
app.use('*', logger(console.log));

const MIN_PRICE_USDC = 0.5;
const PLATFORM_MVP = 'github';
const DEFAULT_ARC_CHAIN_ID = '5042002';
const DEFAULT_ARC_USDC = '0x3600000000000000000000000000000000000000';
const DEFAULT_ARC_RPC = 'https://rpc.testnet.arc.network';

const ZKSEND_PAYMENTS_ABI = [
  {
    inputs: [{ name: '', type: 'uint256' }],
    name: 'payments',
    outputs: [
      { name: 'paymentId', type: 'uint256' },
      { name: 'sender', type: 'address' },
      { name: 'socialIdentityHash', type: 'bytes32' },
      { name: 'platform', type: 'string' },
      { name: 'amount', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'claimed', type: 'bool' },
      { name: 'createdAt', type: 'uint256' },
      { name: 'claimedAt', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

let supabase: ReturnType<typeof createClient> | null = null;

function getSupabaseClient() {
  if (supabase) return supabase;
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL and SERVICE_ROLE_KEY must be configured');
  }
  supabase = createClient(supabaseUrl, supabaseKey);
  return supabase;
}

function getArcChainId(): string {
  return Deno.env.get('ARC_CHAIN_ID')?.trim() || DEFAULT_ARC_CHAIN_ID;
}

function getArcUsdcAddress(): string {
  return (Deno.env.get('ARC_USDC_ADDRESS')?.trim() || DEFAULT_ARC_USDC).toLowerCase();
}

function getZkSendContractAddress(): string | null {
  const raw =
    Deno.env.get('ZKSEND_CONTRACT_ADDRESS')?.trim() ||
    Deno.env.get('VITE_ARC_ZKSEND_CONTRACT_ADDRESS')?.trim();
  return raw ? raw.toLowerCase() : null;
}

function getArcRpcUrl(): string {
  return Deno.env.get('ARC_RPC_URL')?.trim() || DEFAULT_ARC_RPC;
}

function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/^@/, '').toLowerCase();
  return value || null;
}

function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!value || !/^[a-z0-9][a-z0-9/_-]*$/.test(value)) return null;
  return value;
}

function parsePriceUsdc(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return n;
}

function buildSocialIdentity(platform: string, username: string): string {
  return `${platform}:${username}`;
}

function generateIdentityHash(platform: string, username: string): `0x${string}` {
  return keccak256(toBytes(buildSocialIdentity(platform, username)));
}

function parseUsdcToWei(priceUsdc: number): bigint {
  return BigInt(Math.round(priceUsdc * 1_000_000));
}

function extractSlugFromPath(path: string): string {
  const prefix = '/paywall/';
  const idx = path.indexOf(prefix);
  if (idx === -1) return '';
  return decodeURIComponent(path.slice(idx + prefix.length)).replace(/^\/+|\/+$/g, '');
}

type VerifiedGithubUser = {
  id: string;
  login: string;
};

async function verifyGithubAccessToken(accessToken: string): Promise<VerifiedGithubUser | null> {
  const token = accessToken.trim();
  if (!token) return null;

  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      console.warn('[creator-paywall] GitHub token verify failed:', response.status);
      return null;
    }
    const data = (await response.json()) as { id?: number; login?: string };
    const login = normalizeHandle(data.login);
    if (data.id == null || !login) return null;
    return { id: String(data.id), login };
  } catch (err) {
    console.error('[creator-paywall] GitHub API error:', err);
    return null;
  }
}

async function assertGithubOwnsHandle(
  accessToken: string,
  handle: string,
): Promise<VerifiedGithubUser | null> {
  const user = await verifyGithubAccessToken(accessToken);
  if (!user || user.login !== handle) return null;
  return user;
}

type OnChainPayment = {
  paymentId: bigint;
  sender: Address;
  socialIdentityHash: `0x${string}`;
  platform: string;
  amount: bigint;
  token: Address;
  recipient: Address;
  claimed: boolean;
};

async function readZkSendPayment(paymentId: bigint): Promise<OnChainPayment | null> {
  const contractAddress = getZkSendContractAddress();
  if (!contractAddress) return null;

  const client = createPublicClient({
    transport: http(getArcRpcUrl()),
  });

  try {
    const row = (await client.readContract({
      address: contractAddress as Address,
      abi: ZKSEND_PAYMENTS_ABI,
      functionName: 'payments',
      args: [paymentId],
    })) as readonly [
      bigint,
      Address,
      `0x${string}`,
      string,
      bigint,
      Address,
      Address,
      boolean,
      bigint,
      bigint,
    ];

    if (row[0] === 0n) return null;

    return {
      paymentId: row[0],
      sender: row[1],
      socialIdentityHash: row[2],
      platform: row[3],
      amount: row[4],
      token: row[5],
      recipient: row[6],
      claimed: row[7],
    };
  } catch (err) {
    console.error('[creator-paywall] on-chain read failed:', err);
    return null;
  }
}

function build402Response(paywall: {
  slug: string;
  platform: string;
  handle: string;
  identity_hash: string;
  price_usdc: string;
  title: string;
}) {
  const chainId = getArcChainId();
  const contractAddress = getZkSendContractAddress();
  const usdcAddress = getArcUsdcAddress();

  const body = {
    error: 'payment_required',
    paywall: {
      slug: paywall.slug,
      title: paywall.title,
      priceUsdc: paywall.price_usdc,
      recipient: { platform: paywall.platform, handle: paywall.handle },
      identityHash: paywall.identity_hash,
      chainId,
      contractAddress,
      usdcAddress,
      settlement: 'zksend_create_payment',
      minPriceUsdc: String(MIN_PRICE_USDC),
    },
  };

  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Sendly realm="creator-paywall", price="${paywall.price_usdc}", currency="USDC", chain="arc"`,
    },
  });
}

type PaywallRow = {
  id: string;
  slug: string;
  owner_github_user_id: number | string;
  owner_github_login: string;
  platform: string;
  handle: string;
  identity_hash: string;
  price_usdc: string;
  title: string;
  content_body: string;
  active: boolean;
};

async function loadPaywallBySlug(slug: string): Promise<PaywallRow | null> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('creator_paywalls')
    .select('*')
    .eq('slug', slug)
    .eq('active', true)
    .maybeSingle();
  if (error) {
    console.error('[creator-paywall] load paywall error:', error);
    return null;
  }
  return data as PaywallRow | null;
}

async function hasExistingUnlock(paywallId: string, paymentId: string): Promise<boolean> {
  const client = getSupabaseClient();
  const { data } = await client
    .from('creator_paywall_unlocks')
    .select('id')
    .eq('paywall_id', paywallId)
    .eq('payment_id', paymentId)
    .maybeSingle();
  return Boolean(data);
}

async function recordUnlock(params: {
  paywallId: string;
  paymentId: string;
  txHash: string | null;
  payerAddress: string | null;
  source: string;
}) {
  const client = getSupabaseClient();
  const { error } = await client.from('creator_paywall_unlocks').insert({
    paywall_id: params.paywallId,
    payment_id: params.paymentId,
    tx_hash: params.txHash,
    payer_address: params.payerAddress,
    source: params.source === 'agent' ? 'agent' : 'human',
  });
  if (error && !String(error.message).includes('duplicate')) {
    console.error('[creator-paywall] unlock insert error:', error);
    throw error;
  }
}

async function verifyAndUnlock(
  paywall: PaywallRow,
  paymentIdRaw: string,
  txHash: string | null,
  source: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!/^\d+$/.test(paymentIdRaw)) {
    return { ok: false, reason: 'invalid_payment_id' };
  }

  const paymentId = BigInt(paymentIdRaw);

  if (await hasExistingUnlock(paywall.id, paymentIdRaw)) {
    return { ok: true };
  }

  const onChain = await readZkSendPayment(paymentId);
  if (!onChain) {
    console.warn('[creator-paywall] verify failed: payment not found on-chain', paymentIdRaw);
    return { ok: false, reason: 'payment_not_found' };
  }

  const expectedHash = paywall.identity_hash.toLowerCase();
  const actualHash = onChain.socialIdentityHash.toLowerCase();
  if (expectedHash !== actualHash) {
    console.warn('[creator-paywall] verify failed: identity mismatch', { expectedHash, actualHash });
    return { ok: false, reason: 'identity_mismatch' };
  }

  const minWei = parseUsdcToWei(parseFloat(paywall.price_usdc));
  if (onChain.amount < minWei) {
    console.warn('[creator-paywall] verify failed: insufficient amount');
    return { ok: false, reason: 'insufficient_amount' };
  }

  if (onChain.token.toLowerCase() !== getArcUsdcAddress()) {
    return { ok: false, reason: 'invalid_token' };
  }

  if (onChain.claimed) {
    return { ok: false, reason: 'payment_already_claimed' };
  }

  await recordUnlock({
    paywallId: paywall.id,
    paymentId: paymentIdRaw,
    txHash,
    payerAddress: onChain.sender,
    source,
  });

  return { ok: true };
}

app.get('/', (c) =>
  c.json({
    status: 'ok',
    service: 'creator-paywall',
    settlement: 'zksend_arc_usdc',
    routes: [
      'GET /paywall/:slug',
      'POST /paywall',
      'PATCH /paywall/:slug',
      'GET /openapi.json',
      'GET /llms.txt',
    ],
  }),
);

app.get('/openapi.json', (c) => {
  const chainId = getArcChainId();
  const contractAddress = getZkSendContractAddress();
  return c.json({
    openapi: '3.1.0',
    info: {
      title: 'Sendly Creator Paywall',
      version: '1.0.0',
      description:
        'HTTP 402 paywall with Arc USDC settlement via ZkSend to github social identity. No Tempo/pathUSD.',
    },
    paths: {
      '/paywall/{slug}': {
        get: {
          summary: 'Access paid content',
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'X-Sendly-Payment-Id', in: 'header', schema: { type: 'string' } },
            { name: 'X-Sendly-Tx-Hash', in: 'header', schema: { type: 'string' } },
            { name: 'X-Sendly-Source', in: 'header', schema: { type: 'string', enum: ['human', 'agent'] } },
          ],
          responses: {
            '200': { description: 'Unlocked content' },
            '402': { description: 'Payment required — pay via ZkSend.createPayment on Arc' },
          },
        },
      },
      '/paywall': {
        post: {
          summary: 'Create paywall (authenticated creator, verified GitHub)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['slug', 'handle', 'priceUsdc', 'title', 'contentBody', 'githubAccessToken'],
                },
              },
            },
          },
        },
      },
    },
    'x-settlement': {
      chainId,
      contractAddress,
      usdcAddress: getArcUsdcAddress(),
      method: 'ZkSend.createPayment',
      platform: PLATFORM_MVP,
    },
  });
});

app.get('/llms.txt', (c) => {
  const base = Deno.env.get('PUBLIC_CREATOR_PAYWALL_URL')?.trim() || '/functions/v1/creator-paywall';
  const text = `# Sendly Creator Paywall (Arc USDC / ZkSend)

Settlement: ZkSend.createPayment on Arc Testnet USDC to github:<handle>.
Do NOT use Tempo, pathUSD, or mpp-gateway.

## Unlock flow
1. GET ${base}/paywall/{slug}
2. If HTTP 402, read JSON paywall instructions (identityHash, priceUsdc, contractAddress).
3. On Arc: approve USDC then ZkSend.createPayment(identityHash, "github", amountWei, usdc).
   Agent option: circle wallet execute --chain ARC-TESTNET (see Circle Agent Stack docs).
4. POST payment index to /zk-sender/payments (optional but recommended).
5. Retry GET with headers:
   - X-Sendly-Payment-Id: <paymentId>
   - X-Sendly-Tx-Hash: <txHash>
   - X-Sendly-Source: agent|human
6. HTTP 200 returns content_body.

Min price: ${MIN_PRICE_USDC} USDC.
MVP platform: github only.
`;
  return c.text(text, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
});

app.get('/paywall/*', async (c) => {
  try {
    const slug = extractSlugFromPath(c.req.path);
    if (!slug) return c.json({ error: 'slug required' }, 400);

    const paywall = await loadPaywallBySlug(slug);
    if (!paywall) return c.json({ error: 'paywall not found' }, 404);

    const paymentId = c.req.header('X-Sendly-Payment-Id')?.trim() || '';
    const txHash = c.req.header('X-Sendly-Tx-Hash')?.trim() || null;
    const source = c.req.header('X-Sendly-Source')?.trim().toLowerCase() || 'human';

    if (!paymentId) {
      return build402Response(paywall);
    }

    const verified = await verifyAndUnlock(paywall, paymentId, txHash, source);
    if (!verified.ok) {
      return build402Response(paywall);
    }

    return c.json({
      unlocked: true,
      slug: paywall.slug,
      title: paywall.title,
      contentBody: paywall.content_body,
      recipient: { platform: paywall.platform, handle: paywall.handle },
      paymentId,
      txHash,
    });
  } catch (err) {
    console.error('[creator-paywall] GET error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.post('/paywall', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const githubAccessToken =
      typeof body.githubAccessToken === 'string'
        ? body.githubAccessToken.trim()
        : typeof body.github_access_token === 'string'
          ? body.github_access_token.trim()
          : '';
    const slug = normalizeSlug(body.slug);
    const handle = normalizeHandle(body.handle);
    const price = parsePriceUsdc(body.priceUsdc ?? body.price_usdc);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const contentBody = typeof body.contentBody === 'string' ? body.contentBody : '';

    if (!githubAccessToken) return c.json({ error: 'githubAccessToken is required' }, 400);
    if (!slug) return c.json({ error: 'invalid slug' }, 400);
    if (!handle) return c.json({ error: 'invalid github handle' }, 400);
    if (price == null || price < MIN_PRICE_USDC) {
      return c.json({ error: `price must be at least ${MIN_PRICE_USDC} USDC` }, 400);
    }
    if (!title) return c.json({ error: 'title is required' }, 400);
    if (!contentBody.trim()) return c.json({ error: 'contentBody is required' }, 400);

    const githubUser = await assertGithubOwnsHandle(githubAccessToken, handle);
    if (!githubUser) {
      return c.json(
        {
          error: 'Verified GitHub account required',
          details: 'Connect GitHub on zk host and use your authenticated login as handle',
        },
        403,
      );
    }

    const identityHash = generateIdentityHash(PLATFORM_MVP, handle);
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('creator_paywalls')
      .insert({
        slug,
        owner_github_user_id: Number(githubUser.id),
        owner_github_login: githubUser.login,
        platform: PLATFORM_MVP,
        handle,
        identity_hash: identityHash,
        price_usdc: String(price),
        title,
        content_body: contentBody,
      })
      .select(
        'id, slug, platform, handle, price_usdc, title, identity_hash, owner_github_user_id, owner_github_login, created_at',
      )
      .single();

    if (error) {
      if (String(error.message).includes('duplicate') || error.code === '23505') {
        return c.json({ error: 'slug already exists' }, 409);
      }
      console.error('[creator-paywall] insert error:', error);
      return c.json({ error: error.message }, 500);
    }

    return c.json({ paywall: data }, 201);
  } catch (err) {
    console.error('[creator-paywall] POST error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.patch('/paywall/*', async (c) => {
  try {
    const slug = extractSlugFromPath(c.req.path);
    const body = await c.req.json().catch(() => ({}));
    const githubAccessToken =
      typeof body.githubAccessToken === 'string'
        ? body.githubAccessToken.trim()
        : typeof body.github_access_token === 'string'
          ? body.github_access_token.trim()
          : '';
    if (!slug || !githubAccessToken) {
      return c.json({ error: 'slug and githubAccessToken required' }, 400);
    }

    const githubUser = await verifyGithubAccessToken(githubAccessToken);
    if (!githubUser) return c.json({ error: 'invalid github token' }, 401);

    const client = getSupabaseClient();
    const { data: existing } = await client
      .from('creator_paywalls')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (!existing) return c.json({ error: 'paywall not found' }, 404);
    if (String(existing.owner_github_user_id) !== githubUser.id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.title === 'string' && body.title.trim()) updates.title = body.title.trim();
    if (typeof body.contentBody === 'string' && body.contentBody.trim()) {
      updates.content_body = body.contentBody;
    }
    if (body.priceUsdc != null) {
      const price = parsePriceUsdc(body.priceUsdc);
      if (price == null || price < MIN_PRICE_USDC) {
        return c.json({ error: `price must be at least ${MIN_PRICE_USDC} USDC` }, 400);
      }
      updates.price_usdc = String(price);
    }
    if (typeof body.active === 'boolean') updates.active = body.active;

    const { data, error } = await client
      .from('creator_paywalls')
      .update(updates)
      .eq('id', existing.id)
      .select('id, slug, platform, handle, price_usdc, title, active, updated_at')
      .single();

    if (error) return c.json({ error: error.message }, 500);
    return c.json({ paywall: data });
  } catch (err) {
    console.error('[creator-paywall] PATCH error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

Deno.serve((req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return app.fetch(req);
});
