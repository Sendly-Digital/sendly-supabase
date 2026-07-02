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
    'authorization, x-client-info, apikey, content-type, x-sendly-payment-id, x-sendly-tx-hash, x-sendly-source, x-sendly-github-token, x-sendly-oauth-platform, x-sendly-oauth-token, x-sendly-oauth-username',
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
      'X-Sendly-Github-Token',
      'X-Sendly-Oauth-Platform',
      'X-Sendly-Oauth-Token',
      'X-Sendly-Oauth-Username',
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

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function verifyOAuthHandle(
  platform: string,
  accessToken: string,
  expectedHandle: string,
  attestedUsername?: string,
): Promise<boolean> {
  const handle = normalizeHandle(expectedHandle);
  if (!handle || !accessToken.trim()) return false;

  try {
    if (platform === 'github') {
      const user = await verifyGithubAccessToken(accessToken);
      return Boolean(user && user.login === handle);
    }

    if (platform === 'twitter') {
      const response = await fetch('https://api.x.com/2/users/me?user.fields=username', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        const data = (await response.json()) as { data?: { username?: string } };
        const username = normalizeHandle(data.data?.username);
        return Boolean(username && username === handle);
      }
      const attested = normalizeHandle(attestedUsername);
      return Boolean(attested && attested === handle);
    }

    if (platform === 'twitch') {
      const clientId = Deno.env.get('TWITCH_CLIENT_ID')?.trim() || Deno.env.get('VITE_TWITCH_CLIENT_ID')?.trim();
      if (!clientId) return false;
      const response = await fetch('https://api.twitch.tv/helix/users', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': clientId,
        },
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { data?: Array<{ login?: string }> };
      const login = normalizeHandle(data.data?.[0]?.login);
      return Boolean(login && login === handle);
    }

    if (platform === 'telegram') {
      const payload = decodeJwtPayload(accessToken);
      const exp = typeof payload?.exp === 'number' ? payload.exp : null;
      if (exp && exp < Math.floor(Date.now() / 1000)) return false;
      let username = normalizeHandle(
        typeof payload?.username === 'string' ? payload.username : null,
      );
      if (!username) {
        const zktlsUrl = Deno.env.get('ZKTLS_SERVICE_URL')?.trim();
        if (zktlsUrl) {
          const response = await fetch(`${zktlsUrl.replace(/\/$/, '')}/api/telegram/me`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (response.ok) {
            const data = (await response.json()) as { login?: string };
            username = normalizeHandle(data.login);
          }
        }
      }
      return Boolean(username && username === handle);
    }

    if (platform === 'gmail') {
      const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { email?: string };
      const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
      const emailHandle = email.includes('@') ? email.split('@')[0] : email;
      return emailHandle === handle || email === handle;
    }

    if (platform === 'linkedin') {
      const response = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { preferred_username?: string; name?: string };
      const username = normalizeHandle(data.preferred_username || data.name);
      return Boolean(username && username === handle);
    }
  } catch (err) {
    console.error(`[creator-paywall] ${platform} OAuth verify error:`, err);
  }

  return false;
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

function buildOwnerUnlockJson(paywall: PaywallRow) {
  return {
    unlocked: true,
    slug: paywall.slug,
    title: paywall.title,
    contentBody: paywall.content_body,
    recipient: { platform: paywall.platform, handle: paywall.handle },
    paymentId: null,
    txHash: null,
    owner: true,
  };
}

async function tryOwnerBypass(
  paywall: PaywallRow,
  headers: {
    githubToken: string;
    oauthPlatform: string;
    oauthToken: string;
    oauthUsername: string;
  },
): Promise<boolean> {
  const { githubToken, oauthPlatform, oauthToken, oauthUsername } = headers;

  if (paywall.platform === 'github') {
    if (!githubToken && !(oauthPlatform === 'github' && oauthToken)) return false;
    const token = githubToken || oauthToken;
    const gh = await verifyGithubAccessToken(token);
    const ownerLogin = paywall.owner_github_login
      ? normalizeHandle(paywall.owner_github_login)
      : paywall.handle;
    return Boolean(gh && ownerLogin && gh.login === ownerLogin);
  }

  if (!oauthToken || oauthPlatform !== paywall.platform) return false;
  return verifyOAuthHandle(paywall.platform, oauthToken, paywall.handle, oauthUsername);
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
      'GET /creator/:platform/:handle',
      'POST /creator/profile',
      'PATCH /creator/profile',
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
          summary: 'Create paywall (authenticated creator; GitHub verified, other platforms attested)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['slug', 'handle', 'priceUsdc', 'title', 'contentBody'],
                },
              },
            },
          },
        },
      },
      '/creator/{platform}/{handle}': {
        get: {
          summary: 'Public creator profile with active article metadata (no content_body)',
          parameters: [
            { name: 'platform', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'handle', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Profile and article list' },
            '404': { description: 'Profile not found' },
          },
        },
      },
      '/creator/profile': {
        post: { summary: 'Idempotent upsert of creator profile (GitHub verified, others attested)' },
        patch: { summary: 'Update creator profile display_name/bio/avatar_url (owner only)' },
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

Browse a creator's articles: GET ${base}/creator/{platform}/{handle} (metadata only, no content_body).
Min price: ${MIN_PRICE_USDC} USDC.
Supported platforms: twitter, github, twitch, gmail, linkedin, telegram (github ownership is server-verified; others are OAuth-attested).
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

    // Owner bypass: creator can read their own article when OAuth matches platform+handle.
    const githubToken = c.req.header('X-Sendly-Github-Token')?.trim() || '';
    const oauthPlatform = c.req.header('X-Sendly-Oauth-Platform')?.trim().toLowerCase() || '';
    const oauthToken = c.req.header('X-Sendly-Oauth-Token')?.trim() || '';
    const oauthUsername = c.req.header('X-Sendly-Oauth-Username')?.trim() || '';
    const isOwner = await tryOwnerBypass(paywall, {
      githubToken,
      oauthPlatform,
      oauthToken,
      oauthUsername,
    });
    if (isOwner) {
      return c.json(buildOwnerUnlockJson(paywall));
    }

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
    const platform =
      typeof body.platform === 'string' && body.platform.trim()
        ? body.platform.trim().toLowerCase()
        : PLATFORM_MVP;
    const slug = normalizeSlug(body.slug);
    const handle = normalizeHandle(body.handle);
    const price = parsePriceUsdc(body.priceUsdc ?? body.price_usdc);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const contentBody = typeof body.contentBody === 'string' ? body.contentBody : '';

    if (!isSupportedPlatform(platform)) return c.json({ error: 'unsupported platform' }, 400);
    if (!slug) return c.json({ error: 'invalid slug' }, 400);
    if (!handle) return c.json({ error: 'invalid handle' }, 400);
    if (price == null || price < MIN_PRICE_USDC) {
      return c.json({ error: `price must be at least ${MIN_PRICE_USDC} USDC` }, 400);
    }
    if (!title) return c.json({ error: 'title is required' }, 400);
    if (!contentBody.trim()) return c.json({ error: 'contentBody is required' }, 400);

    // GitHub: strong server-side ownership verify. Other platforms: OAuth-attested (Phase 1).
    let ownerGithubUserId: number | null = null;
    let ownerGithubLogin: string | null = null;
    if (platform === 'github') {
      if (!githubAccessToken) return c.json({ error: 'githubAccessToken is required' }, 400);
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
      ownerGithubUserId = Number(githubUser.id);
      ownerGithubLogin = githubUser.login;
    }

    const identityHash = generateIdentityHash(platform, handle);
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('creator_paywalls')
      .insert({
        slug,
        owner_github_user_id: ownerGithubUserId,
        owner_github_login: ownerGithubLogin,
        platform,
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

    // Ensure a creator profile exists for this identity
    await ensureProfile({
      platform,
      handle,
      displayName: ownerGithubLogin ?? handle,
      ownerGithubUserId,
    });

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

// ---------------------------------------------------------------------------
// Creator profiles (Phase 1): profile entity + list-by-creator
// ---------------------------------------------------------------------------

const SUPPORTED_PLATFORMS = ['twitter', 'github', 'twitch', 'gmail', 'linkedin', 'telegram'] as const;
type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

function isSupportedPlatform(value: string): value is SupportedPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

function serverTeaser(markdown: string, maxChars = 280): string {
  const trimmed = (markdown ?? '').trim();
  if (!trimmed) return '';
  const firstBlock = trimmed.split(/\n\n+/)[0]?.trim() ?? trimmed;
  const singleLine = firstBlock.replace(/\s+/g, ' ');
  if (singleLine.length <= maxChars) return singleLine;
  const cut = singleLine.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base}…`;
}

type ProfileRow = {
  id: string;
  platform: string;
  handle: string;
  identity_hash: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  owner_github_user_id: number | string | null;
  created_at: string;
};

function serializeProfile(profile: ProfileRow) {
  return {
    platform: profile.platform,
    handle: profile.handle,
    displayName: profile.display_name,
    bio: profile.bio,
    avatarUrl: profile.avatar_url,
    identityHash: profile.identity_hash,
  };
}

async function loadProfile(platform: string, handle: string): Promise<ProfileRow | null> {
  const client = getSupabaseClient();
  const { data } = await client
    .from('creator_profiles')
    .select('*')
    .eq('platform', platform)
    .eq('handle', handle)
    .maybeSingle();
  return (data as ProfileRow | null) ?? null;
}

async function listCreatorArticles(platform: string, handle: string) {
  const client = getSupabaseClient();
  const { data } = await client
    .from('creator_paywalls')
    .select('slug, title, price_usdc, content_body, created_at')
    .eq('platform', platform)
    .eq('handle', handle)
    .eq('active', true)
    .order('created_at', { ascending: false });
  return (data ?? []).map((row: Record<string, unknown>) => ({
    slug: row.slug as string,
    title: row.title as string,
    priceUsdc: row.price_usdc as string,
    teaser: serverTeaser((row.content_body as string) ?? ''),
    createdAt: row.created_at as string,
  }));
}

async function ensureProfile(params: {
  platform: string;
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  ownerGithubUserId?: number | null;
}): Promise<void> {
  const existing = await loadProfile(params.platform, params.handle);
  if (existing) return;
  const client = getSupabaseClient();
  await client
    .from('creator_profiles')
    .insert({
      platform: params.platform,
      handle: params.handle,
      identity_hash: generateIdentityHash(params.platform, params.handle),
      display_name: params.displayName ?? params.handle,
      avatar_url: params.avatarUrl ?? null,
      owner_github_user_id: params.ownerGithubUserId ?? null,
    })
    .select('id')
    .maybeSingle();
}

app.get('/creator/:platform/:handle', async (c) => {
  try {
    const platform = (c.req.param('platform') ?? '').toLowerCase();
    const handle = normalizeHandle(c.req.param('handle'));
    if (!isSupportedPlatform(platform)) return c.json({ error: 'unsupported platform' }, 400);
    if (!handle) return c.json({ error: 'invalid handle' }, 400);

    const profile = await loadProfile(platform, handle);
    const articles = await listCreatorArticles(platform, handle);
    if (!profile && articles.length === 0) {
      return c.json({ error: 'profile not found' }, 404);
    }

    return c.json({
      profile: profile
        ? serializeProfile(profile)
        : {
            platform,
            handle,
            displayName: handle,
            bio: null,
            avatarUrl: null,
            identityHash: generateIdentityHash(platform, handle),
          },
      articles,
    });
  } catch (err) {
    console.error('[creator-paywall] GET creator error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.post('/creator/profile', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const platform = typeof body.platform === 'string' ? body.platform.toLowerCase() : '';
    const handle = normalizeHandle(body.handle);
    const githubAccessToken =
      typeof body.githubAccessToken === 'string' ? body.githubAccessToken.trim() : '';

    if (!isSupportedPlatform(platform)) return c.json({ error: 'unsupported platform' }, 400);
    if (!handle) return c.json({ error: 'invalid handle' }, 400);

    let ownerGithubUserId: number | null = null;
    if (platform === 'github') {
      const githubUser = githubAccessToken
        ? await assertGithubOwnsHandle(githubAccessToken, handle)
        : null;
      if (!githubUser) return c.json({ error: 'Verified GitHub account required' }, 403);
      ownerGithubUserId = Number(githubUser.id);
    }

    const existing = await loadProfile(platform, handle);
    if (existing) return c.json({ profile: serializeProfile(existing), created: false });

    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim()
        : handle;
    const bio = typeof body.bio === 'string' ? body.bio : null;
    const avatarUrl = typeof body.avatarUrl === 'string' ? body.avatarUrl : null;

    const client = getSupabaseClient();
    const { data, error } = await client
      .from('creator_profiles')
      .insert({
        platform,
        handle,
        identity_hash: generateIdentityHash(platform, handle),
        display_name: displayName,
        bio,
        avatar_url: avatarUrl,
        owner_github_user_id: ownerGithubUserId,
      })
      .select('*')
      .single();

    if (error) {
      if (String(error.message).includes('duplicate') || error.code === '23505') {
        const again = await loadProfile(platform, handle);
        return c.json({ profile: again ? serializeProfile(again) : null, created: false });
      }
      return c.json({ error: error.message }, 500);
    }

    return c.json({ profile: serializeProfile(data as ProfileRow), created: true }, 201);
  } catch (err) {
    console.error('[creator-paywall] POST profile error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.patch('/creator/profile', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const platform = typeof body.platform === 'string' ? body.platform.toLowerCase() : '';
    const handle = normalizeHandle(body.handle);
    const githubAccessToken =
      typeof body.githubAccessToken === 'string' ? body.githubAccessToken.trim() : '';

    if (!isSupportedPlatform(platform)) return c.json({ error: 'unsupported platform' }, 400);
    if (!handle) return c.json({ error: 'invalid handle' }, 400);

    const existing = await loadProfile(platform, handle);
    if (!existing) return c.json({ error: 'profile not found' }, 404);

    if (platform === 'github') {
      const githubUser = githubAccessToken ? await verifyGithubAccessToken(githubAccessToken) : null;
      if (!githubUser || githubUser.login !== handle) return c.json({ error: 'forbidden' }, 403);
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.displayName === 'string' && body.displayName.trim()) {
      updates.display_name = body.displayName.trim();
    }
    if (typeof body.bio === 'string') updates.bio = body.bio;
    if (typeof body.avatarUrl === 'string') updates.avatar_url = body.avatarUrl;

    const client = getSupabaseClient();
    const { data, error } = await client
      .from('creator_profiles')
      .update(updates)
      .eq('id', existing.id)
      .select('*')
      .single();

    if (error) return c.json({ error: error.message }, 500);
    return c.json({ profile: serializeProfile(data as ProfileRow) });
  } catch (err) {
    console.error('[creator-paywall] PATCH profile error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

Deno.serve((req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return app.fetch(req);
});
