import { Hono } from 'npm:hono';
import { cors } from 'npm:hono/cors';
import { logger } from 'npm:hono/logger';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { keccak256, toBytes, type Address } from 'npm:viem';
import { createArcPublicClient, getArcRpcUrl } from './arcRpc.ts';
import { verifyGithubWebhookSignature } from './githubWebhook.ts';
import {
  listPolicies as listPrPolicies,
  paySocialIdentity,
  processMergedPullRequestWebhook,
  syncClaimStatuses,
  upsertPolicy,
  type GithubPullRequestPayload,
  type PrPayoutDeps,
} from './prPayout.ts';
import { loadCorePolicy, type CoreDeps } from './payoutCore.ts';
import {
  registerBountyFromLabel,
  resolveBountyOnMerge,
  type GithubIssuesPayload,
} from './bountyEscrow.ts';
import { processReleaseDividend, type GithubReleasePayload } from './releaseDividend.ts';
import {
  recordReviewEscrow,
  settleReviewsOnMerge,
  type GithubReviewPayload,
} from './reviewToEarn.ts';
import { listRepoPayouts } from './repoPayouts.ts';
import {
  listCitationSources,
  registerCitationSourceFromBody,
} from './citationSources.ts';
import { runCitationDemo, seedCitationSourcesFromPaywalls } from './citationRunner.ts';
import {
  buildTwitchUidIdentity,
  generateTwitchUidHash,
  getSocialIdentity,
} from './twitchIdentity.ts';
import { listTwitchPayouts, syncTwitchClaimStatuses } from './twitchPayoutCore.ts';
import {
  extractVerificationChallenge,
  insertEventSubDedupe,
  lookupSubscriptionSecret,
  markSubscriptionRevoked,
  parseTwitchWebhookHeaders,
  verifyTwitchWebhookHmac,
} from './twitchWebhook.ts';
import { processChannelRaid, type ChannelRaidEvent } from './raidPayout.ts';
import {
  createCampaign,
  listCampaigns,
  listPolicies as listTwitchPolicies,
  serializeCampaign,
  serializePolicy,
  updateCampaign,
  upsertRaidPolicy,
} from './twitchCampaigns.ts';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-sendly-payment-id, x-sendly-tx-hash, x-sendly-source, x-sendly-github-token, x-sendly-oauth-platform, x-sendly-oauth-token, x-sendly-oauth-username, x-hub-signature-256, x-github-event, twitch-eventsub-message-id, twitch-eventsub-message-timestamp, twitch-eventsub-message-signature, twitch-eventsub-message-type, twitch-eventsub-subscription-type, twitch-eventsub-subscription-id',
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
      'X-Hub-Signature-256',
      'X-GitHub-Event',
      'Twitch-Eventsub-Message-Id',
      'Twitch-Eventsub-Message-Timestamp',
      'Twitch-Eventsub-Message-Signature',
      'Twitch-Eventsub-Message-Type',
      'Twitch-Eventsub-Subscription-Type',
      'Twitch-Eventsub-Subscription-Id',
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

function getPrPayoutDeps(): PrPayoutDeps {
  return {
    getClient: getSupabaseClient,
    getArcConfig: () => ({
      chainId: getArcChainId(),
      usdcAddress: getArcUsdcAddress(),
      zkSendAddress: getZkSendContractAddress() ?? '',
      rpcUrl: getArcRpcUrl(),
    }),
    generateIdentityHash,
  };
}

function isTwitchRaidPayoutsEnabled(): boolean {
  return Deno.env.get('TWITCH_RAID_PAYOUTS_ENABLED')?.trim().toLowerCase() === 'true';
}

function getCoreDeps(): CoreDeps {
  const prDeps = getPrPayoutDeps();
  return {
    getClient: getSupabaseClient,
    generateIdentityHash,
    pay: (platform, handle, amountUsdc) =>
      paySocialIdentity(prDeps, platform, handle, amountUsdc),
  };
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
      const data = (await response.json()) as {
        data?: Array<{ id?: string; login?: string; display_name?: string }>;
      };
      const user = data.data?.[0];
      if (!user?.id) return false;

      const uidMatch = handle.match(/^uid:(\d+)$/);
      if (uidMatch) {
        return String(user.id) === uidMatch[1];
      }

      const login = normalizeHandle(user.login);
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

  const client = createArcPublicClient();

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
      'GET /lepton-hackathon',
      'POST /webhooks/github',
      'POST /webhooks/twitch',
      'GET /pr-payouts',
      'GET /twitch-payouts',
      'GET /twitch/campaigns',
      'POST /twitch/campaigns',
      'PATCH /twitch/campaigns/:id',
      'POST /twitch/payout-policy',
      'GET /twitch/payout-policies',
      'GET /twitch/identity/:userId',
      'GET /pr-payout-policy',
      'POST /pr-payout-policy',
      'GET /citation/sources',
      'POST /citation/sources',
      'POST /citation/demo-run',
      'POST /citation/seed-from-paywalls',
    ],
  }),
);

function getPublicBase(): string {
  return Deno.env.get('PUBLIC_CREATOR_PAYWALL_URL')?.trim() || '/functions/v1/creator-paywall';
}

function buildSettlement() {
  return {
    chainId: getArcChainId(),
    contractAddress: getZkSendContractAddress(),
    usdcAddress: getArcUsdcAddress(),
    method: 'ZkSend.createPayment',
    platformSource: 'Read per-paywall from the 402 response: paywall.recipient.platform',
    supportedPlatforms: ['twitter', 'github', 'twitch', 'gmail', 'linkedin', 'telegram'],
    minPriceUsdc: String(MIN_PRICE_USDC),
  };
}

function buildAgentResources(base: string) {
  return [
    {
      type: 'llms',
      url: `${base}/llms.txt`,
      method: 'GET',
      description: 'Plain-text unlock flow for AI agents (HTTP 402 → pay on Arc → retry with headers).',
    },
    {
      type: 'openapi',
      url: `${base}/openapi.json`,
      method: 'GET',
      description: 'OpenAPI 3.1.0 spec with x-settlement (Arc chainId, ZkSend contract, USDC).',
    },
    {
      type: 'paywall',
      url: `${base}/paywall/{slug}`,
      method: 'GET',
      description:
        'Access paid content. Returns HTTP 402 with payment instructions when locked; HTTP 200 with content_body once paid (send X-Sendly-Payment-Id, X-Sendly-Tx-Hash, X-Sendly-Source headers).',
    },
    {
      type: 'creator-profile',
      url: `${base}/creator/{platform}/{handle}`,
      method: 'GET',
      description: 'Public creator profile with active article metadata (no content_body).',
    },
    {
      type: 'github-repo-webhook',
      url: `${base}/webhooks/github`,
      method: 'POST',
      description:
        'GitHub webhook (Repo Treasury). Dispatches by X-GitHub-Event: pull_request (merge payout + bounty resolve + review settle), issues (register bounty:<amount> label), release (published → split pool among authors), pull_request_review (review-to-earn escrow). Pays github:identity from sponsor pool. X-Hub-Signature-256 required.',
    },
    {
      type: 'repo-payouts',
      url: `${base}/pr-payouts`,
      method: 'GET',
      description:
        'Public payout receipts across all kinds (merge, bounty, release, review): repo, recipient, amount, kind, tx_hash, claim_status, skip_reason.',
    },
    {
      type: 'citation-sources',
      url: `${base}/citation/sources`,
      method: 'GET',
      description: 'Registered citation sources (paywall slug or external URL) for agent grounding.',
    },
    {
      type: 'citation-demo',
      url: `${base}/citation/demo-run`,
      method: 'POST',
      description:
        'Demo research agent: pays for registered paywall slugs via real ZkSend.createPayment (sponsor pool), returns answer with citations.',
    },
    {
      type: 'twitch-raid-webhook',
      url: `${base}/webhooks/twitch`,
      method: 'POST',
      description:
        'Twitch EventSub webhook (Stream Treasury). Handles channel.raid → pays twitch:uid:{raider_id} from campaign pool. HMAC verified; dedupe by Twitch-Eventsub-Message-Id.',
    },
    {
      type: 'twitch-campaigns',
      url: `${base}/twitch/campaigns`,
      method: 'GET',
      description: 'List Twitch raid payout campaigns (budget, broadcaster, status).',
    },
    {
      type: 'twitch-payouts',
      url: `${base}/twitch-payouts`,
      method: 'GET',
      description: 'Raid payout receipts (recipient uid, amount, tx_hash, claim_status, skip_reason).',
    },
  ];
}

app.get('/lepton-hackathon', (c) => {
  const base = getPublicBase();
  const demoSlug = Deno.env.get('LEPTON_DEMO_SLUG')?.trim();

  const body: Record<string, unknown> = {
    service: 'sendly-creator-paywall',
    description:
      'Social identity settlement for open-source work and live creator events: autonomous PR payouts to github:handle, Twitch Raid-to-Pay to twitch:uid:{id}, and citation tolls via HTTP 402.',
    hackathon: 'lepton',
    hero: 'github-pr-payout-agent',
    heroes: ['github-pr-payout-agent', 'twitch-raid-payout-agent'],
    auth: 'Most GET endpoints accept optional Authorization: Bearer <supabase anon key>. GitHub webhooks use X-Hub-Signature-256 only. Twitch EventSub uses HMAC (Twitch-Eventsub-Message-Signature).',
    resources: buildAgentResources(base),
    settlement: buildSettlement(),
    twitchRaidPayouts: {
      enabled: isTwitchRaidPayoutsEnabled(),
      identityFormat: 'twitch:uid:{user_id}',
      webhookUrl: `${base}/webhooks/twitch`,
      note: 'Raid pays FROM raider (from_broadcaster_user_id) when campaign targets TO broadcaster (to_broadcaster_user_id).',
    },
  };

  if (demoSlug) {
    body.example = {
      slug: demoSlug,
      url: `${base}/paywall/${demoSlug}`,
      method: 'GET',
      description: 'Existing demo paywall - GET returns HTTP 402 with payment instructions.',
    };
  }

  return c.json(body);
});

app.get('/openapi.json', (c) => {
  const chainId = getArcChainId();
  const contractAddress = getZkSendContractAddress();
  return c.json({
    openapi: '3.1.0',
    info: {
      title: 'Sendly Creator Paywall',
      version: '1.0.0',
      description:
        'HTTP 402 paywall with Arc USDC settlement via ZkSend to a social identity (twitter, github, twitch, gmail, linkedin, telegram). Read the target platform/handle from the 402 response (paywall.recipient).',
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
            '402': { description: 'Payment required - pay via ZkSend.createPayment on Arc' },
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
      '/webhooks/github': {
        post: {
          summary: 'GitHub webhook (Repo Treasury) - dispatched by X-GitHub-Event',
          description:
            'Requires X-Hub-Signature-256 (HMAC-SHA256). Handles pull_request (merge payout + bounty resolve + review settle), issues (bounty:<amount> label), release (published → split pool among authors), pull_request_review (review escrow). Unknown events are ignored.',
        },
      },
      '/pr-payouts': {
        get: {
          summary: 'List repo payout receipts (all kinds: merge, bounty, release, review)',
          responses: { '200': { description: 'Payout events with kind, tx_hash, claim_status, skip_reason' } },
        },
      },
      '/pr-payout-policy': {
        get: { summary: 'List repo payout policies (sponsor pool, per-PR amount, caps)' },
        post: { summary: 'Upsert payout policy for a demo repo' },
      },
      '/citation/sources': {
        get: { summary: 'List active citation sources (slug or external URL)' },
        post: { summary: 'Register citation source' },
      },
      '/citation/demo-run': {
        post: {
          summary: 'Run demo research agent - real 402-style payments for registered paywall slugs',
        },
      },
      '/webhooks/twitch': {
        post: {
          summary: 'Twitch EventSub webhook (Stream Treasury / Raid-to-Pay)',
          description:
            'Handles webhook_callback_verification (returns challenge), notification (channel.raid → pay twitch:uid:{raider}), revocation. HMAC: Twitch-Eventsub-Message-Signature over message_id + timestamp + body.',
        },
      },
      '/twitch/campaigns': {
        get: { summary: 'List Twitch raid payout campaigns' },
        post: { summary: 'Create campaign (draft or active)' },
      },
      '/twitch/campaigns/{id}': {
        patch: { summary: 'Update campaign status, budget, dates' },
      },
      '/twitch/payout-policy': {
        post: { summary: 'Upsert raid payout policy for a campaign' },
      },
      '/twitch/payout-policies': {
        get: { summary: 'List Twitch payout policies' },
      },
      '/twitch-payouts': {
        get: {
          summary: 'List Twitch raid payout receipts',
          responses: { '200': { description: 'Payout events with tx_hash, claim_status, skip_reason' } },
        },
      },
      '/twitch/identity/{userId}': {
        get: {
          summary: 'Lookup canonical twitch:uid identity hash and login snapshot',
          parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
    },
    'x-settlement': {
      chainId,
      contractAddress,
      usdcAddress: getArcUsdcAddress(),
      method: 'ZkSend.createPayment',
      platformSource: 'Read per-paywall from the 402 response: paywall.recipient.platform',
      supportedPlatforms: ['twitter', 'github', 'twitch', 'gmail', 'linkedin', 'telegram'],
    },
  });
});

app.get('/llms.txt', (c) => {
  const base = Deno.env.get('PUBLIC_CREATOR_PAYWALL_URL')?.trim() || '/functions/v1/creator-paywall';
  const text = `# Sendly Creator Paywall (Arc USDC / ZkSend)

Settlement: ZkSend.createPayment on Arc Testnet USDC to a social identity <platform>:<handle>.
The platform is NOT always github - read it from the 402 response (paywall.recipient.platform).

## Unlock flow (paywall / citation)
1. GET ${base}/paywall/{slug}
2. If HTTP 402, read JSON paywall instructions (identityHash, priceUsdc, contractAddress, recipient.platform, recipient.handle).
3. On Arc: approve USDC then ZkSend.createPayment(identityHash, recipient.platform, amountWei, usdc).
   Use the exact platform from the 402 response (e.g. "twitter" or "github") - a wrong platform will not match identityHash.
   Agent option: circle wallet execute --chain ARC-TESTNET (see Circle Agent Stack docs).
4. POST payment index to /zk-sender/payments (optional but recommended).
5. Retry GET with headers:
   - X-Sendly-Payment-Id: <paymentId>
   - X-Sendly-Tx-Hash: <txHash>
   - X-Sendly-Source: agent|human
6. HTTP 200 returns content_body.

## PR Payout Agent (hero - Lepton)
1. Maintainer configures policy: POST ${base}/pr-payout-policy (repo_id, per_pr_amount_usdc, caps).
2. GitHub webhook: POST ${base}/webhooks/github (pull_request closed + merged=true).
3. Agent checks policy, anti-abuse (bots, self-merge, budget), pays github:author from sponsor pool via ZkSend.
4. Receipts: GET ${base}/pr-payouts (tx_hash, claim_status).
5. Contributor claims via existing Sendly zkTLS GitHub ownership - no wallet required upfront.

## Repo Treasury - more GitHub events (same rail)
Webhook is dispatched by X-GitHub-Event. Configure the demo repo webhook for: pull_request, issues, release, pull_request_review.
- Issue Bounty Escrow: label an issue "bounty:<amount>" (e.g. bounty:2). When a merged PR closes it (Fixes/Closes/Resolves #N) the PR author is paid the bounty. Label must exist before merge; one issue paid once.
- Release Dividend: on a published release, the release_pool_usdc is split equally among distinct non-bot authors of PRs since the previous release (requires GITHUB_API_TOKEN for compare).
- Review-to-Earn: a submitted review (changes_requested, or approved with body >= review_min_chars) is escrowed; reviewers (not the author, capped by max_reviewers_per_pr) are paid review_amount_usdc when the PR merges.
Policy per-kind: bounty_enabled, release_pool_usdc, split_mode, review_amount_usdc, review_min_chars, max_reviewers_per_pr.
Receipts include a "kind" field (merge|bounty|release|review) and skip_reason for audit.

## Twitch Stream Treasury / Raid-to-Pay (Lepton)
Canonical identity: twitch:uid:{user_id} (hash = keccak256("twitch:uid:{user_id}")). Login is snapshot only.

1. Create campaign: POST ${base}/twitch/campaigns { sponsorId, broadcasterUserId, name, totalBudgetUsdc, status: "active" }.
2. Set raid policy: POST ${base}/twitch/payout-policy { campaignId, ratePerViewerUsdc, maxPerEventUsdc, minViewers, maxPerDayUsdc }.
3. EventSub webhook: POST ${base}/webhooks/twitch (channel.raid on to_broadcaster_user_id).
4. On raid: pays twitch:uid:{from_broadcaster_user_id} (raider) from campaign budget via ZkSend.
5. Receipts: GET ${base}/twitch-payouts (tx_hash, claim_status).
6. Identity lookup: GET ${base}/twitch/identity/{userId}.
7. Contributor claims via zkTLS Twitch proof with contextMessage = "twitch:uid:{id}".

Formula: amount = min(viewers * rate_per_viewer, max_per_event); skip if viewers < min_viewers.
Anti-abuse: self_raid, allowlist, one payout per raider per campaign per UTC day, campaign + policy daily caps.
Feature flag: TWITCH_RAID_PAYOUTS_ENABLED=true required for raid processing (verification challenge always accepted).

## Citation via 402
1. Register sources: GET/POST ${base}/citation/sources (slug = existing paywall, or external url for registry).
2. Demo agent: POST ${base}/citation/demo-run { "question": "..." } - pays each slug via real Arc tx, returns cited answer.
3. Same settlement as paywall unlock - attribution becomes settlement.

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

app.post('/webhooks/github', async (c) => {
  try {
    const secret = Deno.env.get('GITHUB_WEBHOOK_SECRET')?.trim();
    if (!secret) {
      return c.json({ error: 'GITHUB_WEBHOOK_SECRET not configured' }, 500);
    }

    const rawBody = await c.req.text();
    const signature = c.req.header('X-Hub-Signature-256');
    const event = c.req.header('X-GitHub-Event') ?? '';

    if (!(await verifyGithubWebhookSignature(rawBody, signature, secret))) {
      return c.json({ error: 'invalid signature' }, 401);
    }

    if (event === 'ping') {
      return c.json({ ok: true, pong: true });
    }

    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const coreDeps = getCoreDeps();

    switch (event) {
      case 'pull_request': {
        const prPayload = payload as GithubPullRequestPayload;
        const repoId = (payload as { repository?: { id?: number } }).repository?.id;
        const policy = repoId != null ? await loadCorePolicy(getSupabaseClient(), repoId) : null;

        // Hero merge payout + bounty resolve + review settle share one payload;
        // isolate failures so a broken scenario never blocks the others.
        const hero = await processMergedPullRequestWebhook(getPrPayoutDeps(), prPayload).catch(
          (e) => ({ handled: false, status: `error:${e instanceof Error ? e.message : 'err'}` }),
        );
        const bounty = await resolveBountyOnMerge(coreDeps, policy, payload).catch((e) => ({
          handled: false,
          paid: 0,
          results: [`error:${e instanceof Error ? e.message : 'err'}`],
        }));
        const review = await settleReviewsOnMerge(coreDeps, policy, payload).catch((e) => ({
          handled: false,
          paid: 0,
          results: [`error:${e instanceof Error ? e.message : 'err'}`],
        }));
        return c.json({ ok: true, event, merge: hero, bounty, review });
      }

      case 'issues': {
        const result = await registerBountyFromLabel(
          getSupabaseClient(),
          payload as GithubIssuesPayload,
        );
        return c.json({ ok: true, event, ...result });
      }

      case 'release': {
        const releasePayload = payload as GithubReleasePayload;
        const repoId = releasePayload.repository?.id;
        const policy = repoId != null ? await loadCorePolicy(getSupabaseClient(), repoId) : null;
        const result = await processReleaseDividend(coreDeps, policy, releasePayload);
        return c.json({ ok: true, event, ...result });
      }

      case 'pull_request_review': {
        const reviewPayload = payload as GithubReviewPayload;
        const repoId = reviewPayload.repository?.id;
        const policy = repoId != null ? await loadCorePolicy(getSupabaseClient(), repoId) : null;
        const result = await recordReviewEscrow(getSupabaseClient(), policy, reviewPayload);
        return c.json({ ok: true, event, ...result });
      }

      default:
        return c.json({ ok: true, event, ignored: true });
    }
  } catch (err) {
    console.error('[creator-paywall] github webhook error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.get('/pr-payouts', async (c) => {
  try {
    await syncClaimStatuses(getPrPayoutDeps());
    const receipts = await listRepoPayouts(getSupabaseClient());
    return c.json({
      receipts: receipts.map((r) => ({
        kind: r.kind,
        repo: r.repo,
        prNumber: r.prNumber,
        author: r.recipient,
        recipient: r.recipient,
        amount: r.amount,
        status: r.status,
        paymentId: r.paymentId,
        txHash: r.txHash,
        claimStatus: r.claimStatus,
        skipReason: r.skipReason,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('[creator-paywall] pr-payouts error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.get('/repo-bounties', async (c) => {
  try {
    const { data, error } = await getSupabaseClient()
      .from('issue_bounties')
      .select('repo_full_name, issue_number, amount_usdc, status')
      .eq('status', 'open')
      .order('repo_full_name')
      .order('issue_number');
    if (error) throw error;
    return c.json({
      bounties: (data ?? []).map((b) => ({
        repoFullName: (b as { repo_full_name: string }).repo_full_name,
        issueNumber: (b as { issue_number: number }).issue_number,
        amountUsdc: (b as { amount_usdc: string }).amount_usdc,
        status: (b as { status: string }).status,
      })),
    });
  } catch (err) {
    console.error('[creator-paywall] repo-bounties error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.get('/pr-payout-policy', async (c) => {
  try {
    const policies = await listPrPolicies(getSupabaseClient());
    return c.json({
      policies: policies.map((p) => ({
        repoId: p.repo_id,
        repoFullName: p.repo_full_name,
        sponsorPoolRef: p.sponsor_pool_ref,
        perPrAmountUsdc: p.per_pr_amount_usdc,
        dailyCapUsdc: p.daily_cap_usdc,
        budgetRemainingUsdc: p.budget_remaining_usdc,
        active: p.active,
        bountyEnabled: p.bounty_enabled,
        releasePoolUsdc: p.release_pool_usdc,
        splitMode: p.split_mode,
        reviewAmountUsdc: p.review_amount_usdc,
        reviewMinChars: p.review_min_chars,
        maxReviewersPerPr: p.max_reviewers_per_pr,
      })),
      spendingPolicyNote:
        'Circle Agent Wallet spending policy (per-tx / daily cap) is a second guardrail alongside DB policy.',
    });
  } catch (err) {
    console.error('[creator-paywall] pr-payout-policy GET error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.post('/pr-payout-policy', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const repoId = typeof body.repoId === 'number' ? body.repoId : parseInt(String(body.repoId ?? ''), 10);
    const repoFullName = typeof body.repoFullName === 'string' ? body.repoFullName.trim() : '';
    const perPrAmountUsdc = parsePriceUsdc(body.perPrAmountUsdc ?? body.per_pr_amount_usdc);
    const dailyCapUsdc = parsePriceUsdc(body.dailyCapUsdc ?? body.daily_cap_usdc) ?? 50;
    const budgetRemainingUsdc = parsePriceUsdc(body.budgetRemainingUsdc ?? body.budget_remaining_usdc) ?? 100;

    if (!Number.isFinite(repoId) || !repoFullName) {
      return c.json({ error: 'repoId and repoFullName required' }, 400);
    }
    if (perPrAmountUsdc == null || perPrAmountUsdc < MIN_PRICE_USDC) {
      return c.json({ error: `perPrAmountUsdc must be at least ${MIN_PRICE_USDC}` }, 400);
    }

    const releasePoolUsdc = parsePriceUsdc(body.releasePoolUsdc ?? body.release_pool_usdc);
    const reviewAmountUsdc = parsePriceUsdc(body.reviewAmountUsdc ?? body.review_amount_usdc);
    const splitModeRaw = body.splitMode ?? body.split_mode;
    const reviewMinCharsRaw = body.reviewMinChars ?? body.review_min_chars;
    const maxReviewersRaw = body.maxReviewersPerPr ?? body.max_reviewers_per_pr;
    const bountyEnabledRaw = body.bountyEnabled ?? body.bounty_enabled;

    const policy = await upsertPolicy(getSupabaseClient(), {
      repoId,
      repoFullName,
      perPrAmountUsdc,
      dailyCapUsdc,
      budgetRemainingUsdc,
      active: body.active !== false,
      bountyEnabled: typeof bountyEnabledRaw === 'boolean' ? bountyEnabledRaw : undefined,
      releasePoolUsdc: releasePoolUsdc ?? undefined,
      splitMode: splitModeRaw === 'weighted_by_prs' || splitModeRaw === 'equal' ? splitModeRaw : undefined,
      reviewAmountUsdc: reviewAmountUsdc ?? undefined,
      reviewMinChars: Number.isFinite(Number(reviewMinCharsRaw)) ? Number(reviewMinCharsRaw) : undefined,
      maxReviewersPerPr: Number.isFinite(Number(maxReviewersRaw)) ? Number(maxReviewersRaw) : undefined,
    });
    if (!policy) return c.json({ error: 'failed to save policy' }, 500);
    return c.json({ policy }, 201);
  } catch (err) {
    console.error('[creator-paywall] pr-payout-policy POST error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.get('/citation/sources', async (c) => {
  try {
    const sources = await listCitationSources(getSupabaseClient());
    return c.json({ sources });
  } catch (err) {
    console.error('[creator-paywall] citation sources GET error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.post('/citation/sources', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { source, error } = await registerCitationSourceFromBody(
      getSupabaseClient(),
      body,
      generateIdentityHash,
    );
    if (error) return c.json({ error }, 400);
    if (!source) return c.json({ error: 'failed to register source' }, 500);
    return c.json({ source }, 201);
  } catch (err) {
    console.error('[creator-paywall] citation sources POST error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.post('/citation/seed-from-paywalls', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const slugs = Array.isArray(body.slugs)
      ? body.slugs.map((s: unknown) => String(s).trim()).filter(Boolean)
      : [];
    const demoSlug = Deno.env.get('LEPTON_DEMO_SLUG')?.trim();
    const toSeed = slugs.length ? slugs : demoSlug ? [demoSlug] : [];
    if (!toSeed.length) return c.json({ error: 'provide slugs[] or set LEPTON_DEMO_SLUG' }, 400);

    const sources = await seedCitationSourcesFromPaywalls(
      getSupabaseClient(),
      toSeed,
      generateIdentityHash,
    );
    return c.json({ sources, count: sources.length });
  } catch (err) {
    console.error('[creator-paywall] citation seed error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.post('/citation/demo-run', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const question =
      typeof body.question === 'string' && body.question.trim()
        ? body.question.trim()
        : 'What is Sendly social identity settlement on Arc?';

    const result = await runCitationDemo(getPrPayoutDeps(), question);
    return c.json(result);
  } catch (err) {
    console.error('[creator-paywall] citation demo-run error:', err);
    const msg = err instanceof Error ? err.message : 'Internal error';
    const status = msg === 'no_active_slug_sources' || msg === 'no_paywalls_resolved_for_sources' ? 400 : 500;
    return c.json({ error: msg }, status);
  }
});

app.get('/twitch/identity/:userId', async (c) => {
  try {
    const userId = c.req.param('userId')?.trim();
    if (!userId || !/^\d+$/.test(userId)) {
      return c.json({ error: 'invalid userId' }, 400);
    }
    const client = getSupabaseClient();
    const existing = await getSocialIdentity(client, 'twitch', userId);
    return c.json({
      userId,
      canonical: buildTwitchUidIdentity(userId),
      identityHash: existing?.identity_hash ?? generateTwitchUidHash(userId),
      handle: existing?.handle ?? null,
      displayName: existing?.display_name ?? null,
      lastVerifiedAt: existing?.last_verified_at ?? null,
    });
  } catch (err) {
    console.error('[creator-paywall] twitch identity error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.post('/webhooks/twitch', async (c) => {
  try {
    const rawBody = await c.req.text();
    const wh = parseTwitchWebhookHeaders(c.req.raw.headers);
    if (!wh) {
      return c.json({ error: 'missing twitch eventsub headers' }, 400);
    }

    if (wh.messageType === 'webhook_callback_verification') {
      const challenge = extractVerificationChallenge(rawBody);
      if (!challenge) return c.json({ error: 'missing challenge' }, 400);
      return c.text(challenge, 200, { 'Content-Type': 'text/plain' });
    }

    const client = getSupabaseClient();
    const secret = await lookupSubscriptionSecret(client, wh.subscriptionId);
    if (!secret) {
      return c.json({ error: 'eventsub secret not configured' }, 500);
    }

    const valid = await verifyTwitchWebhookHmac(
      secret,
      wh.messageId,
      wh.timestamp,
      rawBody,
      wh.signature,
    );
    if (!valid) {
      return c.json({ error: 'invalid signature' }, 401);
    }

    const dedupe = await insertEventSubDedupe(client, wh.messageId);
    if (dedupe === 'duplicate') {
      return c.json({ ok: true, duplicate: true });
    }

    if (wh.messageType === 'revocation') {
      if (wh.subscriptionId) {
        await markSubscriptionRevoked(client, wh.subscriptionId);
      }
      return c.json({ ok: true, revoked: true });
    }

    if (wh.messageType !== 'notification') {
      return c.json({ ok: true, ignored: true, messageType: wh.messageType });
    }

    if (!isTwitchRaidPayoutsEnabled()) {
      return c.json({ ok: true, ignored: true, reason: 'TWITCH_RAID_PAYOUTS_ENABLED=false' });
    }

    const payload = JSON.parse(rawBody) as ChannelRaidEvent;
    if (wh.subscriptionType === 'channel.raid' || payload.subscription?.type === 'channel.raid') {
      const result = await processChannelRaid(getPrPayoutDeps(), wh.messageId, payload);
      return c.json({ ok: true, event: 'channel.raid', ...result });
    }

    return c.json({ ok: true, ignored: true, subscriptionType: wh.subscriptionType });
  } catch (err) {
    console.error('[creator-paywall] twitch webhook error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.get('/twitch/campaigns', async (c) => {
  try {
    const campaigns = await listCampaigns(getSupabaseClient());
    return c.json({ campaigns: campaigns.map(serializeCampaign) });
  } catch (err) {
    console.error('[creator-paywall] twitch campaigns GET error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.post('/twitch/campaigns', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const sponsorId = typeof body.sponsorId === 'string' ? body.sponsorId.trim() : '';
    const broadcasterUserId = String(body.broadcasterUserId ?? body.broadcaster_user_id ?? '').trim();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const totalBudgetUsdc = parsePriceUsdc(body.totalBudgetUsdc ?? body.total_budget_usdc);

    if (!sponsorId || !broadcasterUserId || !name) {
      return c.json({ error: 'sponsorId, broadcasterUserId, and name required' }, 400);
    }
    if (totalBudgetUsdc == null || totalBudgetUsdc < MIN_PRICE_USDC) {
      return c.json({ error: `totalBudgetUsdc must be at least ${MIN_PRICE_USDC}` }, 400);
    }

    const statusRaw = typeof body.status === 'string' ? body.status.trim().toLowerCase() : 'draft';
    const status = ['draft', 'active', 'paused', 'ended'].includes(statusRaw) ? statusRaw : 'draft';

    const campaign = await createCampaign(getSupabaseClient(), {
      sponsorId,
      broadcasterUserId,
      broadcasterLoginSnapshot:
        typeof body.broadcasterLoginSnapshot === 'string'
          ? body.broadcasterLoginSnapshot
          : typeof body.broadcaster_login_snapshot === 'string'
            ? body.broadcaster_login_snapshot
            : null,
      name,
      totalBudgetUsdc,
      status,
      startsAt: typeof body.startsAt === 'string' ? body.startsAt : null,
      endsAt: typeof body.endsAt === 'string' ? body.endsAt : null,
      sponsorWalletRef:
        typeof body.sponsorWalletRef === 'string' ? body.sponsorWalletRef : null,
    });
    if (!campaign) return c.json({ error: 'failed to create campaign' }, 500);
    return c.json({ campaign: serializeCampaign(campaign) }, 201);
  } catch (err) {
    console.error('[creator-paywall] twitch campaigns POST error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.patch('/twitch/campaigns/:id', async (c) => {
  try {
    const campaignId = c.req.param('id')?.trim();
    if (!campaignId) return c.json({ error: 'campaign id required' }, 400);

    const body = await c.req.json().catch(() => ({}));
    const statusRaw = typeof body.status === 'string' ? body.status.trim().toLowerCase() : undefined;
    const status =
      statusRaw && ['draft', 'active', 'paused', 'ended'].includes(statusRaw)
        ? statusRaw
        : undefined;

    const campaign = await updateCampaign(getSupabaseClient(), campaignId, {
      status,
      totalBudgetUsdc: parsePriceUsdc(body.totalBudgetUsdc ?? body.total_budget_usdc) ?? undefined,
      remainingBudgetUsdc:
        parsePriceUsdc(body.remainingBudgetUsdc ?? body.remaining_budget_usdc) ?? undefined,
      startsAt: body.startsAt !== undefined ? body.startsAt : undefined,
      endsAt: body.endsAt !== undefined ? body.endsAt : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      broadcasterLoginSnapshot:
        typeof body.broadcasterLoginSnapshot === 'string'
          ? body.broadcasterLoginSnapshot
          : undefined,
    });
    if (!campaign) return c.json({ error: 'campaign not found' }, 404);
    return c.json({ campaign: serializeCampaign(campaign) });
  } catch (err) {
    console.error('[creator-paywall] twitch campaigns PATCH error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.post('/twitch/payout-policy', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const campaignId = typeof body.campaignId === 'string'
      ? body.campaignId.trim()
      : String(body.campaign_id ?? '').trim();
    const ratePerViewerUsdc = parsePriceUsdc(body.ratePerViewerUsdc ?? body.rate_per_viewer_usdc);
    const maxPerEventUsdc = parsePriceUsdc(body.maxPerEventUsdc ?? body.max_per_event_usdc);

    if (!campaignId) return c.json({ error: 'campaignId required' }, 400);
    if (ratePerViewerUsdc == null || maxPerEventUsdc == null) {
      return c.json({ error: 'ratePerViewerUsdc and maxPerEventUsdc required' }, 400);
    }

    const policy = await upsertRaidPolicy(getSupabaseClient(), {
      campaignId,
      minViewers: Number.isFinite(Number(body.minViewers ?? body.min_viewers))
        ? Number(body.minViewers ?? body.min_viewers)
        : undefined,
      ratePerViewerUsdc,
      maxPerEventUsdc,
      maxPerDayUsdc: parsePriceUsdc(body.maxPerDayUsdc ?? body.max_per_day_usdc) ?? undefined,
      allowlistJson: Array.isArray(body.allowlistJson ?? body.allowlist_json)
        ? (body.allowlistJson ?? body.allowlist_json).map(String)
        : undefined,
      enabled: body.enabled !== false,
    });
    if (!policy) return c.json({ error: 'failed to save policy' }, 500);
    return c.json({ policy: serializePolicy(policy) }, 201);
  } catch (err) {
    console.error('[creator-paywall] twitch payout-policy error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.get('/twitch/payout-policies', async (c) => {
  try {
    const policies = await listTwitchPolicies(getSupabaseClient());
    return c.json({ policies: policies.map(serializePolicy) });
  } catch (err) {
    console.error('[creator-paywall] twitch payout-policies error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

app.get('/twitch-payouts', async (c) => {
  try {
    await syncTwitchClaimStatuses(getPrPayoutDeps());
    const payouts = await listTwitchPayouts(getSupabaseClient());
    return c.json({
      receipts: payouts.map((p) => ({
        campaignId: p.campaign_id,
        policyId: p.policy_id,
        recipientUserId: p.recipient_twitch_user_id,
        recipientLogin: p.recipient_login_snapshot,
        amount: p.amount_usdc,
        status: p.status,
        paymentId: p.payment_id,
        txHash: p.tx_hash,
        claimStatus: p.claim_status,
        skipReason: p.skip_reason,
        evidence: p.evidence_json,
        createdAt: p.created_at,
      })),
    });
  } catch (err) {
    console.error('[creator-paywall] twitch-payouts error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});

Deno.serve((req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return app.fetch(req);
});
