import { Hono } from 'npm:hono';
import { cors } from 'npm:hono/cors';
import { logger } from 'npm:hono/logger';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { encodeFunctionData } from 'npm:viem';

// CORS headers for Supabase Edge Function (inlined so no separate file is needed)
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, PATCH, DELETE',
  'Access-Control-Max-Age': '86400',
};

// Important: for Supabase Edge Functions it's recommended to set basePath('/function-name')
// so routes work correctly under /functions/v1/zk-sender/*
const app = new Hono().basePath('/zk-sender');

// Hono CORS middleware for regular requests (responses will have the required headers)
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
    ],
    allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
    credentials: false,
    maxAge: 86400,
    exposeHeaders: ['Content-Length', 'Content-Type'],
  })
);

app.use('*', logger(console.log));

let supabaseUrl: string | undefined;
let supabaseKey: string | undefined;
let supabaseAnonKey: string | undefined;
let supabase: ReturnType<typeof createClient> | null = null;

function getSupabaseClient() {
  if (!supabase) {
    supabaseUrl = Deno.env.get('SUPABASE_URL');
    supabaseKey = Deno.env.get('SERVICE_ROLE_KEY');
    supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? undefined;

    if (!supabaseUrl) {
      throw new Error('SUPABASE_URL is not set in environment variables');
    }

    if (!supabaseKey) {
      throw new Error(
        'SERVICE_ROLE_KEY is not set. ' +
        'Please add it in Supabase Dashboard: Edge Functions → Functions Secrets → Add new secret. ' +
        'Key name: SERVICE_ROLE_KEY (without SUPABASE_ prefix). ' +
        'Value: your service_role key from Settings → API → Project API keys → service_role'
      );
    }

    supabase = createClient(supabaseUrl, supabaseKey);
  }
  return supabase;
}

function normalizeWalletAddress(address: string | null | undefined) {
  return typeof address === 'string' ? address.trim().toLowerCase() : null;
}

/** Normalize recipient username: trim, lowercase, strip leading @ only (preserve @ in emails). */
function normalizeRecipientUsername(raw: string | null | undefined): string | null {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  return s.startsWith('@') ? s.slice(1) : s;
}

/** Normalize chain ID: trim, string (supports numeric or string chain ids). */
function normalizeChainId(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

/** Normalize contract address: trim, lowercase (EVM hex). */
function normalizeContractAddress(raw: string | null | undefined): string | null {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : null;
}

function normalizeProofPlatform(raw: unknown): 'github' | 'twitch' | 'twitter' | 'telegram' | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'github' || value === 'twitch' || value === 'twitter' || value === 'telegram') return value;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function extractClaimProof(raw: unknown): Record<string, unknown> | null {
  const root = asRecord(raw);
  if (!root) return null;
  if (asRecord(root.claimInfo) && asRecord(root.signedClaim)) {
    return root;
  }
  const nested = asRecord(root.proof);
  if (nested && asRecord(nested.claimInfo) && asRecord(nested.signedClaim)) {
    return nested;
  }
  return null;
}

async function logZkTlsFlowEvent(payload: {
  correlation_id: string;
  idempotency_key?: string | null;
  stage: string;
  status: string;
  platform?: string | null;
  handle?: string | null;
  chain_id?: string | null;
  contract_address?: string | null;
  payment_id?: string | null;
  meta?: Record<string, unknown>;
}) {
  try {
    const client = getSupabaseClient();
    await client.from('zktls_flow_events').insert({
      correlation_id: payload.correlation_id,
      idempotency_key: payload.idempotency_key ?? null,
      stage: payload.stage,
      status: payload.status,
      platform: payload.platform ?? null,
      handle: payload.handle ?? null,
      chain_id: payload.chain_id ?? null,
      contract_address: payload.contract_address ?? null,
      payment_id: payload.payment_id ?? null,
      meta: payload.meta ?? {},
    });
  } catch (err) {
    console.error('[zkSEND] failed to log zktls flow event:', err);
  }
}

async function requestZkTlsProofPayload(params: {
  platform: string;
  handle: string;
  correlationId: string;
  externalProof: Record<string, unknown> | null;
}): Promise<{ ok: true; proof: Record<string, unknown>; providerResponse?: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const baseUrl = (Deno.env.get('ZKTLS_SERVICE_URL') || '').replace(/\/$/, '');
  if (!baseUrl) {
    return { ok: false, status: 503, error: 'ZKTLS_SERVICE_URL is not configured' };
  }

  const verifyUrl = `${baseUrl}/api/reclaim/verify`;
  if (params.externalProof) {
    const verifyRes = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proof: params.externalProof,
        platform: params.platform,
        handle: params.handle,
        correlationId: params.correlationId,
      }),
    });
    const verifyBody = (await verifyRes.json().catch(() => ({}))) as Record<string, unknown>;
    const verified = Boolean(verifyBody.valid ?? verifyBody.verified ?? verifyBody.success ?? verifyRes.ok);
    const claimProof = extractClaimProof(verifyBody) ?? params.externalProof;
    if (!verifyRes.ok || !verified || !claimProof) {
      return { ok: false, status: verifyRes.status || 502, error: 'Provided proof is invalid' };
    }
    return { ok: true, proof: claimProof, providerResponse: verifyBody };
  }

  const proveUrl = `${baseUrl}/api/reclaim/zkfetch/prove`;
  const proveRes = await fetch(proveUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: params.platform,
      handle: params.handle,
      correlationId: params.correlationId,
    }),
  });
  const proveBody = (await proveRes.json().catch(() => ({}))) as Record<string, unknown>;
  const generatedProof = extractClaimProof(proveBody);
  if (!proveRes.ok || !generatedProof) {
    return { ok: false, status: proveRes.status || 502, error: 'Failed to generate zkTLS proof' };
  }

  const verifyRes = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: generatedProof,
      platform: params.platform,
      handle: params.handle,
      correlationId: params.correlationId,
    }),
  });
  const verifyBody = (await verifyRes.json().catch(() => ({}))) as Record<string, unknown>;
  const verified = Boolean(verifyBody.valid ?? verifyBody.verified ?? verifyBody.success ?? verifyRes.ok);
  if (!verifyRes.ok || !verified) {
    return { ok: false, status: verifyRes.status || 502, error: 'Generated proof verification failed' };
  }

  return { ok: true, proof: generatedProof, providerResponse: verifyBody };
}

// --- ABI ZkSend / DirectSend for send-transaction (see docs/smart-action-zksend-abi.md) ---
const ZKSEND_ABI = [
  {
    type: 'function',
    name: 'createPayment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_socialIdentityHash', type: 'bytes32' },
      { name: '_platform', type: 'string' },
      { name: '_amount', type: 'uint256' },
      { name: '_token', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claimPayment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_paymentId', type: 'uint256' },
      {
        name: '_proof',
        type: 'tuple',
        components: [
          {
            name: 'claimInfo',
            type: 'tuple',
            components: [
              { name: 'provider', type: 'string' },
              { name: 'parameters', type: 'string' },
              { name: 'context', type: 'string' },
            ],
          },
          {
            name: 'signedClaim',
            type: 'tuple',
            components: [
              {
                name: 'claim',
                type: 'tuple',
                components: [
                  { name: 'identifier', type: 'bytes32' },
                  { name: 'owner', type: 'address' },
                  { name: 'timestampS', type: 'uint32' },
                  { name: 'epoch', type: 'uint32' },
                ],
              },
              { name: 'signatures', type: 'bytes[]' },
            ],
          },
        ],
      },
      { name: '_recipient', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimPayments',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_paymentIds', type: 'uint256[]' },
      {
        name: '_proof',
        type: 'tuple',
        components: [
          {
            name: 'claimInfo',
            type: 'tuple',
            components: [
              { name: 'provider', type: 'string' },
              { name: 'parameters', type: 'string' },
              { name: 'context', type: 'string' },
            ],
          },
          {
            name: 'signedClaim',
            type: 'tuple',
            components: [
              {
                name: 'claim',
                type: 'tuple',
                components: [
                  { name: 'identifier', type: 'bytes32' },
                  { name: 'owner', type: 'address' },
                  { name: 'timestampS', type: 'uint32' },
                  { name: 'epoch', type: 'uint32' },
                ],
              },
              { name: 'signatures', type: 'bytes[]' },
            ],
          },
        ],
      },
      { name: '_recipient', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const DIRECT_SEND_ABI = [
  {
    type: 'function',
    name: 'sendToAddress',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_recipient', type: 'address' },
      { name: '_amount', type: 'uint256' },
      { name: '_token', type: 'address' },
    ],
    outputs: [],
  },
] as const;

/** Contract addresses from env (normalized lower case). */
function getZkSendContractAddress(): string | null {
  const raw = Deno.env.get('ZKSEND_CONTRACT_ADDRESS') ?? Deno.env.get('VITE_ARC_ZKSEND_CONTRACT_ADDRESS');
  return normalizeContractAddress(raw);
}

function getDirectSendContractAddress(): string | null {
  const raw = Deno.env.get('DIRECT_SEND_CONTRACT_ADDRESS') ?? Deno.env.get('VITE_ARC_DIRECT_SEND_CONTRACT_ADDRESS');
  return normalizeContractAddress(raw);
}

/**
 * Returns the ABI for a contract by its address (ZkSend or DirectSend).
 * If contractAddress does not match any known contract — null.
 */
function getAbiForContractAddress(contractAddress: string): typeof ZKSEND_ABI | typeof DIRECT_SEND_ABI | null {
  const addr = normalizeContractAddress(contractAddress);
  if (!addr) return null;
  const zkAddr = getZkSendContractAddress();
  const directAddr = getDirectSendContractAddress();
  if (zkAddr && addr === zkAddr) return ZKSEND_ABI;
  if (directAddr && addr === directAddr) return DIRECT_SEND_ABI;
  return null;
}

function extractBearerToken(authHeader: string | undefined | null) {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

// IMPORTANT: we disable verify_jwt at Supabase gateway level (see config.toml)
// so CORS preflight (OPTIONS) doesn't fail. Therefore we verify the token inside the function.
app.use('*', async (c, next) => {
  // keep health-check public
  if (c.req.path === '/') {
    return next();
  }

  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json({ error: 'Missing Authorization bearer token' }, 401);
  }

  const client = getSupabaseClient();

  // 1) Allow calls with public anon key (as in browser)
  if (supabaseAnonKey && token === supabaseAnonKey) {
    return next();
  }

  // 2) Otherwise assume it's the user's access token
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) {
    return c.json({ error: 'Invalid or expired access token' }, 401);
  }

  return next();
});

app.get('/', async (c) => {
  return c.json({
    status: 'ok',
    message: 'zkSEND Edge Function is running',
    timestamp: new Date().toISOString(),
    routes: [
      'POST /payments',
      'PATCH /payments/:paymentId/claim',
      'POST /proof/prepare-claim',
      'POST /direct-send/prepare',
      'POST /wallets/send-transaction',
      'GET /twitter/user?username=...',
      'GET /twitch/user?login=...',
      'GET /github/user?username=...',
      'GET /telegram/user?username=...',
    ],
  });
});

const TWITTER_USER_CACHE_DAYS = 7;

/** In-flight Twitter user lookups by normalized username to avoid duplicate API calls. */
const twitterUserInFlight = new Map<
  string,
  Promise<{ status: number; body: Record<string, unknown> }>
>();

/** Normalize Twitter username for cache key: trim, lowercase, strip leading @. */
function normalizeTwitterUsername(raw: string | null | undefined): string {
  if (raw == null || typeof raw !== 'string') return '';
  return raw.trim().replace(/^@/, '').toLowerCase();
}

/** Fetch Twitter user from API and upsert into cache. Used when cache miss; shared by coalesced requests. */
async function fetchTwitterUserFromApi(
  username: string,
  client: ReturnType<typeof getSupabaseClient>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const apiKey = Deno.env.get('TWITTERAPI_IO_API_KEY');
  if (!apiKey || !apiKey.trim()) {
    return {
      status: 503,
      body: {
        error: 'Twitter user lookup is not configured. Set TWITTERAPI_IO_API_KEY in Edge Function secrets.',
        code: 'TWITTER_NOT_CONFIGURED',
      },
    };
  }

  const searchUrl = `https://api.twitterapi.io/twitter/user/search?query=${encodeURIComponent(username)}`;
  const apiRes = await fetch(searchUrl, {
    method: 'GET',
    headers: { 'X-API-Key': apiKey.trim() },
  });
  const apiBody = await apiRes.text().catch(() => '');

  if (apiRes.status === 429) {
    return { status: 429, body: { error: 'Too many requests. Try again later.', code: 'RATE_LIMITED' } };
  }
  if (apiRes.status === 401 || apiRes.status === 403) {
    return {
      status: apiRes.status === 401 ? 401 : 502,
      body: { error: 'Twitter API access denied', code: 'ACCESS_DENIED' },
    };
  }
  if (!apiRes.ok) {
    console.error('[zkSEND] Twitter API error:', apiRes.status, apiBody.slice(0, 300));
    return { status: 502, body: { error: 'Twitter API error', code: 'API_ERROR' } };
  }

  let data: { users?: Array<{ screen_name?: string; name?: string; profile_image_url_https?: string }> };
  try {
    data = JSON.parse(apiBody);
  } catch {
    return { status: 502, body: { error: 'Invalid Twitter API response', code: 'PARSE_ERROR' } };
  }

  const users = data?.users ?? [];
  const user = users.find(
    (u) => u?.screen_name && u.screen_name.toLowerCase() === username
  ) ?? users[0];
  if (!user || !user.screen_name) {
    return { status: 404, body: { error: 'User not found', code: 'USER_NOT_FOUND' } };
  }

  const payload = {
    username: user.screen_name,
    name: user.name ?? user.screen_name,
    profile_image_url: user.profile_image_url_https ?? null,
  };
  const cacheUsername = user.screen_name.toLowerCase();
  await client
    .from('twitter_user_cache')
    .upsert(
      {
        username: cacheUsername,
        name: payload.name,
        profile_image_url: payload.profile_image_url,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'username' }
    );

  return { status: 200, body: payload };
}

app.get('/twitter/user', async (c) => {
  try {
    const usernameRaw = c.req.query('username');
    const username = normalizeTwitterUsername(usernameRaw);
    if (!username) {
      return c.json({ error: 'Missing or invalid query.username', code: 'MISSING_USERNAME' }, 400);
    }

    const client = getSupabaseClient();

    const cacheCutoff = new Date();
    cacheCutoff.setDate(cacheCutoff.getDate() - TWITTER_USER_CACHE_DAYS);
    const cacheCutoffIso = cacheCutoff.toISOString();

    const { data: cached, error: cacheError } = await client
      .from('twitter_user_cache')
      .select('username, name, profile_image_url')
      .eq('username', username)
      .gte('updated_at', cacheCutoffIso)
      .maybeSingle();

    if (cacheError) {
      console.error('[zkSEND] Twitter cache read error:', cacheError);
    }
    if (cached && cached.username) {
      return c.json({
        username: cached.username,
        name: cached.name ?? cached.username,
        profile_image_url: cached.profile_image_url ?? null,
      });
    }

    let inFlightPromise = twitterUserInFlight.get(username);
    if (!inFlightPromise) {
      inFlightPromise = fetchTwitterUserFromApi(username, client);
      twitterUserInFlight.set(username, inFlightPromise);
      inFlightPromise.finally(() => twitterUserInFlight.delete(username));
    }
    const { status, body } = await inFlightPromise;
    return c.json(body, status);
  } catch (err) {
    console.error('[zkSEND] Twitter user lookup error:', err);
    return c.json(
      { error: err instanceof Error ? err.message : 'Twitter user lookup failed', code: 'INTERNAL_ERROR' },
      500
    );
  }
});

const TWITCH_USER_CACHE_DAYS = 7;

/** In-flight Twitch user lookups by normalized login to avoid duplicate API calls. */
const twitchUserInFlight = new Map<
  string,
  Promise<{ status: number; body: Record<string, unknown> }>
>();

/** Normalize Twitch login for cache key: trim, lowercase, strip leading @. */
function normalizeTwitchLogin(raw: string | null | undefined): string {
  if (raw == null || typeof raw !== 'string') return '';
  return raw.trim().replace(/^@/, '').toLowerCase();
}

/** Get Twitch app access token via Client Credentials. */
async function getTwitchAppToken(): Promise<{ access_token: string } | null> {
  const clientId = Deno.env.get('TWITCH_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('TWITCH_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: params,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ? { access_token: data.access_token } : null;
}

/** Fetch Twitch user from Helix API and upsert into cache. Used when cache miss; shared by coalesced requests. */
async function fetchTwitchUserFromApi(
  login: string,
  client: ReturnType<typeof getSupabaseClient>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const clientId = Deno.env.get('TWITCH_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('TWITCH_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) {
    return {
      status: 503,
      body: {
        error: 'Twitch user lookup is not configured. Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in Edge Function secrets.',
        code: 'TWITCH_NOT_CONFIGURED',
      },
    };
  }

  const tokenData = await getTwitchAppToken();
  if (!tokenData) {
    return {
      status: 503,
      body: {
        error: 'Twitch API access token could not be obtained.',
        code: 'TWITCH_TOKEN_FAILED',
      },
    };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokenData.access_token}`,
    'Client-Id': clientId,
  };

  const usersRes = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    { method: 'GET', headers }
  );
  const usersBody = await usersRes.text().catch(() => '');

  if (usersRes.status === 429) {
    return { status: 429, body: { error: 'Too many requests. Try again later.', code: 'RATE_LIMITED' } };
  }
  if (usersRes.status === 401 || usersRes.status === 403) {
    return {
      status: usersRes.status === 401 ? 401 : 502,
      body: { error: 'Twitch API access denied', code: 'ACCESS_DENIED' },
    };
  }
  if (!usersRes.ok) {
    console.error('[zkSEND] Twitch Helix users error:', usersRes.status, usersBody.slice(0, 300));
    return { status: 502, body: { error: 'Twitch API error', code: 'API_ERROR' } };
  }

  let usersData: { data?: Array<{ id?: string; login?: string; display_name?: string; profile_image_url?: string }> };
  try {
    usersData = JSON.parse(usersBody);
  } catch {
    return { status: 502, body: { error: 'Invalid Twitch API response', code: 'PARSE_ERROR' } };
  }

  const users = usersData?.data ?? [];
  const user = users.find((u) => u?.login?.toLowerCase() === login) ?? users[0];
  if (!user || !user.id || !user.login) {
    return { status: 404, body: { error: 'User not found', code: 'USER_NOT_FOUND' } };
  }

  let followersTotal = 0;
  const followersRes = await fetch(
    `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(user.id)}`,
    { method: 'GET', headers }
  );
  if (followersRes.ok) {
    const followersData = (await followersRes.json()) as { total?: number };
    followersTotal = typeof followersData.total === 'number' ? followersData.total : 0;
  }

  const payload = {
    login: user.login,
    display_name: user.display_name ?? user.login,
    profile_image_url: user.profile_image_url ?? null,
    followers_total: followersTotal,
  };

  const cacheLogin = user.login.toLowerCase();
  await client
    .from('twitch_user_cache')
    .upsert(
      {
        login: cacheLogin,
        display_name: payload.display_name,
        profile_image_url: payload.profile_image_url,
        followers_total: payload.followers_total,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'login' }
    );

  return { status: 200, body: payload };
}

app.get('/twitch/user', async (c) => {
  try {
    const loginRaw = c.req.query('login');
    const login = normalizeTwitchLogin(loginRaw);
    if (!login) {
      return c.json({ error: 'Missing or invalid query.login', code: 'MISSING_LOGIN' }, 400);
    }

    const client = getSupabaseClient();

    const cacheCutoff = new Date();
    cacheCutoff.setDate(cacheCutoff.getDate() - TWITCH_USER_CACHE_DAYS);
    const cacheCutoffIso = cacheCutoff.toISOString();

    const { data: cached, error: cacheError } = await client
      .from('twitch_user_cache')
      .select('login, display_name, profile_image_url, followers_total')
      .eq('login', login)
      .gte('updated_at', cacheCutoffIso)
      .maybeSingle();

    if (cacheError) {
      console.error('[zkSEND] Twitch cache read error:', cacheError);
    }
    if (cached && cached.login) {
      return c.json({
        login: cached.login,
        display_name: cached.display_name ?? cached.login,
        profile_image_url: cached.profile_image_url ?? null,
        followers_total: cached.followers_total ?? 0,
      });
    }

    let inFlightPromise = twitchUserInFlight.get(login);
    if (!inFlightPromise) {
      inFlightPromise = fetchTwitchUserFromApi(login, client);
      twitchUserInFlight.set(login, inFlightPromise);
      inFlightPromise.finally(() => twitchUserInFlight.delete(login));
    }
    const { status, body } = await inFlightPromise;
    return c.json(body, status);
  } catch (err) {
    console.error('[zkSEND] Twitch user lookup error:', err);
    return c.json(
      { error: err instanceof Error ? err.message : 'Twitch user lookup failed', code: 'INTERNAL_ERROR' },
      500
    );
  }
});

const GITHUB_USER_CACHE_DAYS = 7;

/** Normalize GitHub username for lookup: trim, lowercase, strip leading @. */
function normalizeGitHubUsername(raw: string | null | undefined): string {
  if (raw == null || typeof raw !== 'string') return '';
  return raw.trim().replace(/^@/, '').toLowerCase();
}

/** In-flight GitHub user lookups by normalized username. */
const githubUserInFlight = new Map<
  string,
  Promise<{ status: number; body: Record<string, unknown> }>
>();

/** Fetch GitHub user from API and upsert into cache. Used when cache miss; shared by coalesced requests. */
async function fetchGitHubUserFromApi(
  username: string,
  client: ReturnType<typeof getSupabaseClient>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `https://api.github.com/users/${encodeURIComponent(username)}`;
  const apiRes = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const apiBody = await apiRes.text().catch(() => '');

  if (apiRes.status === 404) {
    return { status: 404, body: { error: 'User not found', code: 'USER_NOT_FOUND' } };
  }
  if (apiRes.status === 403) {
    let message = 'Too many requests. Try again later.';
    try {
      const parsed = JSON.parse(apiBody) as { message?: string };
      if (typeof parsed?.message === 'string') message = parsed.message;
    } catch {
      // use default
    }
    return { status: 429, body: { error: message, code: 'RATE_LIMITED' } };
  }
  if (!apiRes.ok) {
    console.error('[zkSEND] GitHub API error:', apiRes.status, apiBody.slice(0, 300));
    return { status: 502, body: { error: 'GitHub API error', code: 'API_ERROR' } };
  }

  let data: { login?: string; name?: string | null; avatar_url?: string | null };
  try {
    data = JSON.parse(apiBody);
  } catch {
    return { status: 502, body: { error: 'Invalid GitHub API response', code: 'PARSE_ERROR' } };
  }

  if (!data?.login) {
    return { status: 404, body: { error: 'User not found', code: 'USER_NOT_FOUND' } };
  }

  const payload = {
    login: data.login,
    name: data.name ?? data.login,
    avatar_url: data.avatar_url ?? null,
  };
  const cacheLogin = data.login.toLowerCase();
  await client
    .from('github_user_cache')
    .upsert(
      {
        login: cacheLogin,
        name: payload.name,
        avatar_url: payload.avatar_url,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'login' }
    );

  return { status: 200, body: payload };
}

app.get('/github/user', async (c) => {
  try {
    const usernameRaw = c.req.query('username');
    const username = normalizeGitHubUsername(usernameRaw);
    if (!username) {
      return c.json({ error: 'Missing or invalid query.username', code: 'MISSING_USERNAME' }, 400);
    }

    const client = getSupabaseClient();

    const cacheCutoff = new Date();
    cacheCutoff.setDate(cacheCutoff.getDate() - GITHUB_USER_CACHE_DAYS);
    const cacheCutoffIso = cacheCutoff.toISOString();

    const { data: cached, error: cacheError } = await client
      .from('github_user_cache')
      .select('login, name, avatar_url')
      .eq('login', username)
      .gte('updated_at', cacheCutoffIso)
      .maybeSingle();

    if (cacheError) {
      console.error('[zkSEND] GitHub cache read error:', cacheError);
    }
    if (cached && cached.login) {
      return c.json({
        login: cached.login,
        name: cached.name ?? cached.login,
        avatar_url: cached.avatar_url ?? null,
      });
    }

    let inFlightPromise = githubUserInFlight.get(username);
    if (!inFlightPromise) {
      inFlightPromise = fetchGitHubUserFromApi(username, client);
      githubUserInFlight.set(username, inFlightPromise);
      inFlightPromise.finally(() => githubUserInFlight.delete(username));
    }
    const { status, body } = await inFlightPromise;
    return c.json(body, status);
  } catch (err) {
    console.error('[zkSEND] GitHub user lookup error:', err);
    return c.json(
      { error: err instanceof Error ? err.message : 'GitHub user lookup failed', code: 'INTERNAL_ERROR' },
      500
    );
  }
});

const TELEGRAM_USER_CACHE_DAYS = 7;

/** In-flight Telegram user lookups by normalized username. */
const telegramUserInFlight = new Map<
  string,
  Promise<{ status: number; body: Record<string, unknown> }>
>();

/** Normalize Telegram username for cache key: trim, lowercase, strip leading @. */
function normalizeTelegramUsername(raw: string | null | undefined): string {
  if (raw == null || typeof raw !== 'string') return '';
  return raw.trim().replace(/^@/, '').toLowerCase();
}

/** Fetch Telegram user from zktls-service and upsert into cache. Used when cache miss; shared by coalesced requests. */
async function fetchTelegramUserFromZktls(
  username: string,
  client: ReturnType<typeof getSupabaseClient>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const baseUrl = (Deno.env.get('ZKTLS_SERVICE_URL') || '').replace(/\/$/, '');
  if (!baseUrl) {
    return {
      status: 503,
      body: {
        error: 'Telegram user lookup is not configured. Set ZKTLS_SERVICE_URL in Edge Function secrets.',
        code: 'TELEGRAM_NOT_CONFIGURED',
      },
    };
  }

  const url = `${baseUrl}/api/telegram/user?username=${encodeURIComponent(username)}`;
  const res = await fetch(url, { method: 'GET' });
  const bodyText = await res.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try {
    body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  } catch {
    body = { error: 'Invalid response', code: 'PARSE_ERROR' };
  }

  if (!res.ok) {
    return {
      status: res.status,
      body: body.error != null ? body : { error: bodyText || 'Request failed', code: 'REQUEST_FAILED' },
    };
  }

  const payloadUsername = typeof body.username === 'string' ? body.username : username;
  const payload = {
    username: payloadUsername,
    name: (typeof body.name === 'string' ? body.name : payloadUsername) ?? payloadUsername,
    profile_image_url: body.profile_image_url ?? null,
  };

  const cacheUsername = payloadUsername.toLowerCase();
  await client
    .from('telegram_user_cache')
    .upsert(
      {
        username: cacheUsername,
        name: payload.name,
        profile_image_url: payload.profile_image_url,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'username' }
    );

  return { status: 200, body: payload };
}

app.get('/telegram/user', async (c) => {
  try {
    const usernameRaw = c.req.query('username');
    const username = normalizeTelegramUsername(usernameRaw);
    if (!username) {
      return c.json({ error: 'Missing or invalid query.username', code: 'MISSING_USERNAME' }, 400);
    }

    const client = getSupabaseClient();

    const cacheCutoff = new Date();
    cacheCutoff.setDate(cacheCutoff.getDate() - TELEGRAM_USER_CACHE_DAYS);
    const cacheCutoffIso = cacheCutoff.toISOString();

    const { data: cached, error: cacheError } = await client
      .from('telegram_user_cache')
      .select('username, name, profile_image_url')
      .eq('username', username)
      .gte('updated_at', cacheCutoffIso)
      .maybeSingle();

    if (cacheError) {
      console.error('[zkSEND] Telegram cache read error:', cacheError);
    }
    if (cached && cached.username) {
      return c.json({
        username: cached.username,
        name: cached.name ?? cached.username,
        profile_image_url: cached.profile_image_url ?? null,
      });
    }

    let inFlightPromise = telegramUserInFlight.get(username);
    if (!inFlightPromise) {
      inFlightPromise = fetchTelegramUserFromZktls(username, client);
      telegramUserInFlight.set(username, inFlightPromise);
      inFlightPromise.finally(() => telegramUserInFlight.delete(username));
    }
    const { status, body } = await inFlightPromise;
    return c.json(body, status);
  } catch (err) {
    console.error('[zkSEND] Telegram user lookup error:', err);
    return c.json(
      { error: err instanceof Error ? err.message : 'Telegram user lookup failed', code: 'INTERNAL_ERROR' },
      500
    );
  }
});

/**
 * POST /proof/prepare-claim — social-handle orchestration:
 * validates inputs, performs zkTLS proof generate/verify, and builds claim package for claimPayment.
 */
app.post('/proof/prepare-claim', async (c) => {
  const correlationId = crypto.randomUUID();
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const platform = normalizeProofPlatform(body.platform);
    const handle = normalizeRecipientUsername(typeof body.handle === 'string' ? body.handle : null);
    const chainId = normalizeChainId(body.chainId as string | number | null | undefined);
    const contractAddress = normalizeContractAddress(body.contractAddress as string | null | undefined);
    const paymentIdRaw = body.paymentId ?? body.payment_id;
    const paymentId = paymentIdRaw != null ? String(paymentIdRaw).trim() : '';
    const recipientWallet = normalizeWalletAddress(
      (body.recipientWallet as string | undefined) ?? (body.recipient_wallet as string | undefined),
    );
    const idempotencyKeyRaw = (body.idempotencyKey as string | undefined) ?? (body.idempotency_key as string | undefined);
    const idempotencyKey = typeof idempotencyKeyRaw === 'string' && idempotencyKeyRaw.trim() ? idempotencyKeyRaw.trim() : null;
    const upstreamCorrelationIdRaw =
      (body.correlationId as string | undefined) ?? (body.correlation_id as string | undefined);
    const upstreamCorrelationId =
      typeof upstreamCorrelationIdRaw === 'string' && upstreamCorrelationIdRaw.trim()
        ? upstreamCorrelationIdRaw.trim()
        : correlationId;
    const externalProof = asRecord(body.proof);

    if (!platform || !handle || !chainId || !contractAddress || !paymentId || !/^\d+$/.test(paymentId) || !recipientWallet) {
      return c.json(
        {
          error:
            'platform, handle, chainId, contractAddress, paymentId and recipientWallet are required',
        },
        400,
      );
    }

    await logZkTlsFlowEvent({
      correlation_id: upstreamCorrelationId,
      idempotency_key: idempotencyKey,
      stage: 'proof_requested',
      status: 'started',
      platform,
      handle,
      chain_id: chainId,
      contract_address: contractAddress,
      payment_id: paymentId,
    });

    const proofResult = await requestZkTlsProofPayload({
      platform,
      handle,
      correlationId: upstreamCorrelationId,
      externalProof,
    });
    if (!proofResult.ok) {
      await logZkTlsFlowEvent({
        correlation_id: upstreamCorrelationId,
        idempotency_key: idempotencyKey,
        stage: 'proof_verified',
        status: 'failed',
        platform,
        handle,
        chain_id: chainId,
        contract_address: contractAddress,
        payment_id: paymentId,
        meta: { error: proofResult.error },
      });
      return c.json({ error: proofResult.error }, proofResult.status);
    }

    await logZkTlsFlowEvent({
      correlation_id: upstreamCorrelationId,
      idempotency_key: idempotencyKey,
      stage: 'proof_verified',
      status: 'ok',
      platform,
      handle,
      chain_id: chainId,
      contract_address: contractAddress,
      payment_id: paymentId,
    });

    const claimPackage = {
      functionName: 'claimPayment',
      args: [paymentId, proofResult.proof, recipientWallet],
    };
    const response = {
      prepared: true,
      flow: 'social_claim',
      stage: 'claim_packaged',
      correlationId: upstreamCorrelationId,
      idempotencyKey,
      platform,
      handle,
      chainId,
      contractAddress,
      paymentId,
      recipientWallet,
      claimPackage,
      sendTransactionRequest: {
        contractAddress,
        functionName: claimPackage.functionName,
        args: claimPackage.args,
      },
    };

    await logZkTlsFlowEvent({
      correlation_id: upstreamCorrelationId,
      idempotency_key: idempotencyKey,
      stage: 'claim_packaged',
      status: 'ok',
      platform,
      handle,
      chain_id: chainId,
      contract_address: contractAddress,
      payment_id: paymentId,
      meta: { recipientWallet },
    });

    return c.json(response);
  } catch (err) {
    console.error('[zkSEND] prepare-claim orchestration error:', err);
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Failed to prepare claim',
        code: 'PREPARE_CLAIM_FAILED',
      },
      500,
    );
  }
});

/**
 * POST /direct-send/prepare — short-path for wallet-to-wallet transfer without social proof.
 */
app.post('/direct-send/prepare', async (c) => {
  const correlationId = crypto.randomUUID();
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const chainId = normalizeChainId(body.chainId as string | number | null | undefined);
    const contractAddress = normalizeContractAddress(body.contractAddress as string | null | undefined);
    const recipientWallet = normalizeWalletAddress(
      (body.recipientWallet as string | undefined) ?? (body.recipient_wallet as string | undefined),
    );
    const amount = body.amount != null ? String(body.amount).trim() : '';
    const token = normalizeContractAddress((body.token as string | undefined) ?? (body.currencyAddress as string | undefined));
    const idempotencyKeyRaw = (body.idempotencyKey as string | undefined) ?? (body.idempotency_key as string | undefined);
    const idempotencyKey = typeof idempotencyKeyRaw === 'string' && idempotencyKeyRaw.trim() ? idempotencyKeyRaw.trim() : null;
    if (!chainId || !contractAddress || !recipientWallet || !amount || !token) {
      return c.json({ error: 'chainId, contractAddress, recipientWallet, amount and token are required' }, 400);
    }

    await logZkTlsFlowEvent({
      correlation_id: correlationId,
      idempotency_key: idempotencyKey,
      stage: 'direct_send_ready',
      status: 'ok',
      platform: null,
      handle: null,
      chain_id: chainId,
      contract_address: contractAddress,
      payment_id: null,
      meta: { recipientWallet, amount, token },
    });

    return c.json({
      prepared: true,
      flow: 'direct_send',
      stage: 'direct_send_ready',
      correlationId,
      idempotencyKey,
      chainId,
      contractAddress,
      functionName: 'sendToAddress',
      args: [recipientWallet, amount, token],
      sendTransactionRequest: {
        contractAddress,
        functionName: 'sendToAddress',
        args: [recipientWallet, amount, token],
      },
    });
  } catch (err) {
    console.error('[zkSEND] direct-send prepare error:', err);
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Failed to prepare direct send',
        code: 'DIRECT_SEND_PREPARE_FAILED',
      },
      500,
    );
  }
});

/**
 * POST /wallets/send-transaction — encodes a ZkSend/DirectSend contract call (see docs/smart-action-zksend-abi.md).
 * Based on contractAddress, the ZkSend or DirectSend ABI is substituted, and calldata is built via viem.
 * Returns encodedData; the actual network submission (Circle API) should be performed by the caller or smart-action.
 */
function parseArgForViem(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return value as `0x${string}`;
    if (/^\d+$/.test(value)) return BigInt(value);
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  return value;
}

app.post('/wallets/send-transaction', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const contractAddressRaw = body?.contractAddress ?? body?.contract_address;
    const functionName = body?.functionName ?? body?.function_name;
    const argsRaw = body?.args;

    const contractAddress = normalizeContractAddress(contractAddressRaw);
    if (!contractAddress) {
      return c.json({ error: 'Missing or invalid contractAddress', code: 'MISSING_CONTRACT' }, 400);
    }
    if (!functionName || typeof functionName !== 'string') {
      return c.json({ error: 'Missing or invalid functionName', code: 'MISSING_FUNCTION' }, 400);
    }
    if (!Array.isArray(argsRaw)) {
      return c.json({ error: 'Missing or invalid args (must be array)', code: 'MISSING_ARGS' }, 400);
    }

    const abi = getAbiForContractAddress(contractAddress);
    if (!abi) {
      return c.json(
        {
          error:
            'Contract address is not a known ZkSend or DirectSend contract. Set ZKSEND_CONTRACT_ADDRESS and/or DIRECT_SEND_CONTRACT_ADDRESS in Edge Function secrets.',
          code: 'UNKNOWN_CONTRACT',
        },
        400
      );
    }

    const args = argsRaw.map(parseArgForViem);
    let encodedData: `0x${string}`;
    try {
      encodedData = encodeFunctionData({
        abi,
        functionName: functionName as 'createPayment' | 'claimPayment' | 'claimPayments' | 'sendToAddress',
        args,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json(
        { error: `Function ${functionName} not found in ABI or invalid args: ${msg}`, code: 'FUNCTION_NOT_FOUND' },
        400
      );
    }

    return c.json({ success: true, encodedData });
  } catch (err) {
    console.error('[zkSEND] send-transaction encode error:', err);
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Failed to encode transaction',
        code: 'ENCODE_ERROR',
      },
      500
    );
  }
});

app.post('/payments', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const paymentIdRaw = body?.paymentId ?? body?.payment_id;
    const senderAddressRaw = body?.senderAddress ?? body?.sender_address;
    const recipientIdentityHash = body?.recipientIdentityHash ?? body?.recipient_identity_hash;
    const platformRaw = body?.platform ?? body?.social_platform;
    const amountRaw = body?.amount;
    const currencyRaw = body?.currency;
    const txHash = body?.txHash ?? body?.tx_hash ?? null;
    const chainIdInput = body?.chainId ?? body?.chain_id ?? null;
    const contractAddressInput = body?.contractAddress ?? body?.contract_address ?? null;
    const usernameInput = body?.recipientUsername ?? body?.recipient_username ?? null;
    const recipientUsername = normalizeRecipientUsername(usernameInput);
    const recipientUsernameRaw =
      body?.recipientUsernameRaw ?? body?.recipient_username_raw ?? (typeof usernameInput === 'string' ? usernameInput : null);

    const paymentId = paymentIdRaw != null ? String(paymentIdRaw).trim() : '';
    if (!paymentId || !/^\d+$/.test(paymentId)) {
      return c.json({ error: 'Invalid or missing paymentId' }, 400);
    }

    const senderAddress = normalizeWalletAddress(senderAddressRaw);
    if (!senderAddress) {
      return c.json({ error: 'Missing senderAddress' }, 400);
    }

    const normalizedPlatform = String(platformRaw || '').toLowerCase().trim();
    if (!normalizedPlatform) {
      return c.json({ error: 'Missing platform' }, 400);
    }

    const amount = amountRaw != null ? String(amountRaw) : '';
    if (!amount) {
      return c.json({ error: 'Missing amount' }, 400);
    }

    const currency = currencyRaw != null ? String(currencyRaw).toUpperCase().trim() : '';
    if (!currency) {
      return c.json({ error: 'Missing currency' }, 400);
    }

    const identityHash = recipientIdentityHash != null ? String(recipientIdentityHash).trim() : '';
    if (!identityHash) {
      return c.json({ error: 'Missing recipientIdentityHash' }, 400);
    }

    const chainId = normalizeChainId(chainIdInput);
    const contractAddress = normalizeContractAddress(contractAddressInput);
    if (!chainId) {
      return c.json({ error: 'Missing chainId' }, 400);
    }
    if (!contractAddress) {
      return c.json({ error: 'Missing contractAddress' }, 400);
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from('zksend_payments')
      .upsert(
        {
          chain_id: chainId,
          contract_address: contractAddress,
          payment_id: paymentId,
          sender_address: senderAddress,
          recipient_identity_hash: identityHash,
          social_platform: normalizedPlatform,
          recipient_username: recipientUsername ?? null,
          recipient_username_raw: recipientUsernameRaw ?? null,
          amount,
          currency,
          tx_hash: txHash,
          claimed: false,
          claimed_at: null,
        },
        { onConflict: 'chain_id,contract_address,payment_id' }
      )
      .select('*')
      .single();

    if (error) {
      console.error('[zkSEND] Failed to store payment:', error);
      return c.json({ error: 'Failed to store zkSEND payment' }, 500);
    }

    return c.json({ success: true, payment: data });
  } catch (error) {
    console.error('[zkSEND] Payment insert error:', error);
    return c.json({ error: 'Failed to store zkSEND payment' }, 500);
  }
});

app.patch('/payments/:paymentId/claim', async (c) => {
  try {
    const paymentId = String(c.req.param('paymentId') || '').trim();
    if (!paymentId || !/^\d+$/.test(paymentId)) {
      return c.json({ error: 'Invalid or missing paymentId' }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const recipientWalletRaw = body?.recipientWallet ?? body?.recipient_wallet;
    const claimTxHash = body?.claimTxHash ?? body?.claim_tx_hash ?? null;
    const senderAddressRaw = body?.senderAddress ?? body?.sender_address;
    const recipientIdentityHash = body?.recipientIdentityHash ?? body?.recipient_identity_hash;
    const platformRaw = body?.platform ?? body?.social_platform;
    const amountRaw = body?.amount;
    const currencyRaw = body?.currency;
    const txHash = body?.txHash ?? body?.tx_hash ?? null;
    const chainIdInputClaim = body?.chainId ?? body?.chain_id ?? null;
    const contractAddressInputClaim = body?.contractAddress ?? body?.contract_address ?? null;
    const usernameInputClaim = body?.recipientUsername ?? body?.recipient_username ?? null;
    const recipientUsernameClaim = normalizeRecipientUsername(usernameInputClaim);
    const recipientUsernameRawClaim =
      body?.recipientUsernameRaw ?? body?.recipient_username_raw ?? (typeof usernameInputClaim === 'string' ? usernameInputClaim : null);

    const recipientWallet = normalizeWalletAddress(recipientWalletRaw);
    if (!recipientWallet) {
      return c.json({ error: 'Missing recipientWallet' }, 400);
    }

    const senderAddress = normalizeWalletAddress(senderAddressRaw);
    const normalizedPlatform = String(platformRaw || '').toLowerCase().trim();
    const amount = amountRaw != null ? String(amountRaw) : '';
    const currency = currencyRaw != null ? String(currencyRaw).toUpperCase().trim() : '';
    const identityHash = recipientIdentityHash != null ? String(recipientIdentityHash).trim() : '';

    if (!senderAddress || !normalizedPlatform || !amount || !currency || !identityHash) {
      return c.json(
        {
          error: 'Missing required fields for claim upsert',
          required: ['senderAddress', 'recipientIdentityHash', 'platform', 'amount', 'currency'],
        },
        400
      );
    }

    const chainIdClaim = normalizeChainId(chainIdInputClaim);
    const contractAddressClaim = normalizeContractAddress(contractAddressInputClaim);
    if (!chainIdClaim) {
      return c.json({ error: 'Missing chainId' }, 400);
    }
    if (!contractAddressClaim) {
      return c.json({ error: 'Missing contractAddress' }, 400);
    }

    const client = getSupabaseClient();
    const claimPayload: Record<string, unknown> = {
      chain_id: chainIdClaim,
      contract_address: contractAddressClaim,
      payment_id: paymentId,
      sender_address: senderAddress,
      recipient_identity_hash: identityHash,
      social_platform: normalizedPlatform,
      ...(recipientUsernameClaim != null && { recipient_username: recipientUsernameClaim }),
      ...(recipientUsernameRawClaim != null && { recipient_username_raw: recipientUsernameRawClaim }),
      amount,
      currency,
      recipient_wallet: recipientWallet,
      claimed: true,
      claimed_at: new Date().toISOString(),
      claim_tx_hash: claimTxHash,
    };
    // Preserve existing tx_hash when not provided in claim body (do not overwrite with null)
    if (txHash != null && String(txHash).trim() !== '') {
      claimPayload.tx_hash = txHash;
    }
    const { data, error } = await client
      .from('zksend_payments')
      .upsert(claimPayload, { onConflict: 'chain_id,contract_address,payment_id' })
      .select('*')
      .single();

    if (error) {
      console.error('[zkSEND] Failed to update claim:', error);
      return c.json({ error: 'Failed to update zkSEND claim' }, 500);
    }

    return c.json({ success: true, payment: data });
  } catch (error) {
    console.error('[zkSEND] Claim update error:', error);
    return c.json({ error: 'Failed to update zkSEND claim' }, 500);
  }
});

// For Supabase Edge Functions: wrap Hono app in Deno.serve
// and return CORS preflight (OPTIONS) as required by official docs.
Deno.serve((req) => {
  // Preflight requests must always return 200 + CORS headers,
  // without executing business logic and without failing on errors.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // All other requests are handled by the Hono app
  return app.fetch(req);
});
