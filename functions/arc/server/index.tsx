import { Hono } from 'npm:hono';
import { cors } from 'npm:hono/cors';
import { logger } from 'npm:hono/logger';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { ethers } from 'npm:ethers@6';
import { encodeFunctionData } from 'npm:viem';
import * as kv from './kv_store.tsx';

// RPC providers per chain for fetching transaction sender addresses
const DEFAULT_ARC_RPC = 'https://arc-testnet.g.alchemy.com/v2/txtfxuHRReih2Iv9VpLUS9Ku6ZuztEQL';
const DEFAULT_AVAX_RPC = 'https://api.avax-test.network/ext/bc/C/rpc';
const DEFAULT_BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const RPC_URLS: Record<number, string> = {
  5042002: Deno.env.get('ARC_RPC_URL') || Deno.env.get('RPC_URL') || DEFAULT_ARC_RPC,
  43113: Deno.env.get('AVAX_RPC_URL') || DEFAULT_AVAX_RPC,
  84532: Deno.env.get('BASE_RPC_URL') || DEFAULT_BASE_SEPOLIA_RPC,
};
const rpcProviderCache: Record<number, ethers.JsonRpcProvider> = {};

function getRpcProvider(chainId: number = 5042002): ethers.JsonRpcProvider {
  const url = RPC_URLS[chainId] || RPC_URLS[5042002];
  if (!rpcProviderCache[chainId]) {
    rpcProviderCache[chainId] = new ethers.JsonRpcProvider(url);
    console.log(`[RPC] Using RPC for chain ${chainId}: ${url.replace(/\/v2\/[^/]+$/, '/v2/***')}`);
  }
  return rpcProviderCache[chainId];
}

/**
 * Get sender address from transaction hash via RPC with retry logic
 * Handles rate limiting (429 errors) with exponential backoff
 */
async function getSenderFromTransaction(txHash: string, chainId: number = 5042002, retries: number = 3): Promise<string | null> {
  const provider = getRpcProvider(chainId);
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Add timeout to prevent hanging requests (8 seconds)
      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 8000);
      });
      
      const txPromise = provider.getTransaction(txHash).then(tx => tx?.from?.toLowerCase() || null);
      
      const result = await Promise.race([txPromise, timeoutPromise]);
      if (result) {
        return result;
      }
      
      // If timeout, retry
      if (attempt < retries - 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff, max 5s
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error: any) {
      // Check if it's a rate limit error (429)
      const isRateLimit = error?.error?.code === 429 || 
                         error?.message?.includes('429') ||
                         error?.message?.includes('compute units');
      
      if (isRateLimit && attempt < retries - 1) {
        // Exponential backoff for rate limits: 2s, 4s, 8s
        const delay = Math.min(2000 * Math.pow(2, attempt), 10000); // Max 10s for rate limits
        console.warn(`[GRAPH] Rate limit hit for tx ${txHash}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // For other errors or final attempt, log and return null
      if (attempt === retries - 1) {
        console.warn(`[GRAPH] Failed to get sender from transaction ${txHash} after ${retries} attempts:`, error?.error?.message || error?.message || error);
      }
      return null;
    }
  }
  
  return null;
}

/**
 * Process array of items in parallel with concurrency limit and rate limiting
 * This prevents overwhelming RPC with too many simultaneous requests
 * Adds small delay between batches to respect rate limits
 */
async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = 10,
  delayBetweenBatches: number = 100 // ms delay between starting new batches
): Promise<R[]> {
  const results: R[] = [];
  const executing: Set<Promise<void>> = new Set();
  let processedCount = 0;
  
  for (const item of items) {
    // Wait if we've reached concurrency limit
    if (executing.size >= concurrency) {
      await Promise.race(executing);
      // Small delay to prevent overwhelming RPC
      if (delayBetweenBatches > 0) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }
    
    // Start processing this item
    const promise = processor(item)
      .then(result => {
        results.push(result);
        processedCount++;
        if (processedCount % 10 === 0) {
          console.log(`[GRAPH] Processed ${processedCount}/${items.length} items`);
        }
      })
      .catch(error => {
        console.error(`[GRAPH] Error in parallel processing:`, error);
        results.push(null as R);
        processedCount++;
      })
      .finally(() => {
        executing.delete(promise);
      });
    
    executing.add(promise);
  }
  
  // Wait for all remaining promises to complete
  await Promise.all(executing);
  return results;
}

const app = new Hono();

// CORS middleware - must be first to handle OPTIONS requests
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
  credentials: false,
  maxAge: 86400,
  exposeHeaders: ['Content-Length', 'Content-Type'],
}));

// Explicit OPTIONS request handling BEFORE any other handlers
app.options('*', async (c) => {
  return c.noContent(204);
});

app.use('*', logger(console.log));

// Health check endpoint - works without checking environment variables
app.get('/', async (c) => {
  return c.json({ 
    status: 'ok', 
    message: 'Edge Function is running',
    timestamp: new Date().toISOString(),
    routes: [
      'POST /gift-cards/twitter/create',
      'GET /gift-cards/twitter/:username',
      'GET /gift-cards/twitter/by-token/:tokenId',
      'POST /gift-cards/twitter/:tokenId/claim',
      'POST /gift-cards/twitch/create',
      'GET /gift-cards/twitch/:username',
      'GET /gift-cards/twitch/by-token/:tokenId',
      'POST /gift-cards/twitch/:tokenId/claim',
      'POST /gift-cards/telegram/create',
      'GET /gift-cards/telegram/:username',
      'GET /gift-cards/telegram/by-token/:tokenId',
      'POST /gift-cards/telegram/:tokenId/claim',
      'POST /gift-cards/tiktok/create',
      'GET /gift-cards/tiktok/:username',
      'GET /gift-cards/tiktok/by-token/:tokenId',
      'POST /gift-cards/tiktok/:tokenId/claim',
      'POST /gift-cards/instagram/create',
      'GET /gift-cards/instagram/:username',
      'GET /gift-cards/instagram/by-token/:tokenId',
      'POST /gift-cards/instagram/:tokenId/claim',
      'POST /zksend/payments',
      'PATCH /zksend/payments/:paymentId/claim',
      'POST /contacts/get-saved-token',
      'POST /contacts/save-token',
      'POST /contacts/get-twitch-token',
      'POST /contacts/sync',
      'POST /wallets/link-telegram',
      'POST /wallets/create-for-social',
      'GET /wallets/get-by-social',
      'POST /wallets/send-transaction',
      'POST /graph/sync-gift-cards',
      'GET /graph/gift-cards',
      'POST /graph/fill-missing-senders'
    ]
  });
});

// Environment variables - checked later when creating client
let supabaseUrl: string | undefined;
let supabaseKey: string | undefined;
let supabase: ReturnType<typeof createClient> | null = null;

function getSupabaseClient() {
  if (!supabase) {
    supabaseUrl = Deno.env.get('SUPABASE_URL');
    supabaseKey = Deno.env.get('SERVICE_ROLE_KEY');
    
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

// Helper function to get leaderboard table name
// Supports both tables: leaderboard_stats (default) and leaderboard_stats_graph_true
// Can be controlled via:
// 1. Environment variable: LEADERBOARD_TABLE (values: 'stats' | 'graph_true' | 'both')
// 2. Query parameter: ?table=stats|graph_true|both
// Default: 'stats' (leaderboard_stats)
function getLeaderboardTableName(queryParam?: string): string | 'both' {
  // Check query parameter first (highest priority)
  if (queryParam) {
    const normalized = queryParam.toLowerCase().trim();
    if (normalized === 'graph_true' || normalized === 'graph') {
      return 'leaderboard_stats_graph_true';
    }
    if (normalized === 'both' || normalized === 'merge') {
      return 'both';
    }
    // Default to 'stats' for any other value
    return 'leaderboard_stats';
  }
  
  // Check environment variable
  const envTable = Deno.env.get('LEADERBOARD_TABLE');
  if (envTable) {
    const normalized = envTable.toLowerCase().trim();
    if (normalized === 'graph_true' || normalized === 'graph') {
      return 'leaderboard_stats_graph_true';
    }
    if (normalized === 'both' || normalized === 'merge') {
      return 'both';
    }
  }
  
  // Default to leaderboard_stats
  return 'leaderboard_stats';
}

// Helper function to get chain_id from request (query param or body)
// Returns ARC chainId (5042002) by default if not specified
function getChainIdFromRequest(query: Record<string, string | undefined>, body?: any): number {
  // Try query parameter first
  if (query.chain_id) {
    const parsed = parseInt(query.chain_id, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  
  // Try body parameter
  if (body?.chain_id) {
    const parsed = parseInt(String(body.chain_id), 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  
  // Default to ARC chainId
  return 5042002;
}

/** Use DB row chain_id when present; otherwise fallback (request default). */
function resolveChainIdForGraphRecord(record: { chain_id?: unknown }, fallback: number): number {
  const raw = record?.chain_id;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const p = parseInt(raw, 10);
    if (!Number.isNaN(p) && p > 0) return p;
  }
  return fallback;
}

/** Match client isChainIdSchemaError: missing chain_id column or PostgREST schema cache. */
function isChainIdSchemaErrorEdge(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = error.message ?? '';
  if (error.code === '42703' && msg.includes('chain_id')) return true;
  if (error.code === 'PGRST204' && msg.includes('chain_id')) return true;
  return false;
}

/** Hint for operators when RPC fails due to missing chain_id DDL or outdated recalculate function. */
const LEADERBOARD_GRAPH_TRUE_CHAIN_ID_MIGRATION_HINT =
  'Apply SQL migrations in order: 039_add_chain_id_to_gift_cards_graph.sql (if gift_cards_graph lacks chain_id), 038_add_chain_id_to_leaderboard_stats_graph_true.sql, 044_recalculate_leaderboard_stats_graph_true_chain_id.sql';

/** Mirror social claim recipient updates into gift_cards_graph for /my when reading from graph. */
async function syncGiftCardsGraphClaimRecipient(
  client: ReturnType<typeof getSupabaseClient>,
  tokenId: string,
  chainId: number,
  patch: {
    recipient_address: string;
    recipient_type: string;
    recipient_username: null;
    updated_at: string;
    last_synced_at: string;
  }
) {
  let { error } = await client
    .from('gift_cards_graph')
    .update(patch)
    .eq('token_id', tokenId)
    .eq('chain_id', chainId);
  if (error && isChainIdSchemaErrorEdge(error)) {
    const r = await client.from('gift_cards_graph').update(patch).eq('token_id', tokenId);
    error = r.error;
  }
  if (error) {
    console.warn('[gift_cards_graph] claim recipient sync failed:', error.message ?? error);
  }
}

// Helper function to verify user authentication
async function verifyUser(request: Request) {
  const accessToken = request.headers.get('Authorization')?.split(' ')[1];
  if (!accessToken) {
    return { user: null, error: 'No access token provided' };
  }
  
  const client = getSupabaseClient();
  const { data: { user }, error } = await client.auth.getUser(accessToken);
  return { user, error };
}

function normalizeWalletAddress(address: string | null | undefined) {
  return typeof address === 'string' ? address.trim().toLowerCase() : null;
}

function normalizeBlockchain(blockchain: string | null | undefined) {
  return typeof blockchain === 'string' ? blockchain.trim().toUpperCase() : null;
}

const ARC_USDC_CONTRACT_LOWER = '0x3600000000000000000000000000000000000000';

/** CCTP Bridge Kit uses increaseAllowance; Arc USDC internal-wallet flows use approve (same as gift cards). */
function remapArcUsdcAllowanceFunction(
  blockchain: string,
  contractAddress: string,
  functionName: string
): string {
  if (
    normalizeBlockchain(blockchain) === 'ARC-TESTNET' &&
    contractAddress.toLowerCase() === ARC_USDC_CONTRACT_LOWER &&
    functionName === 'increaseAllowance'
  ) {
    return 'approve';
  }
  return functionName;
}

async function pollCircleW3sTransactionStatus(
  transactionId: string,
  circleApiKey: string,
  entitySecretCiphertext: string,
  maxWaitMs = 90_000
): Promise<{ txHash?: string; transactionState?: string; error?: string }> {
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${circleApiKey}`,
    'Content-Type': 'application/json',
  };
  const developerHeaders = {
    ...baseHeaders,
    'X-Entity-Secret-Ciphertext': entitySecretCiphertext,
  };
  const commonUrl = `https://api.circle.com/v1/w3s/transactions/${transactionId}`;
  const developerUrl = `https://api.circle.com/v1/w3s/developer/transactions/${transactionId}`;
  const failStates = new Set(['FAILED', 'DENIED', 'CANCELLED']);
  const okStates = new Set(['COMPLETE', 'CONFIRMED', 'SETTLED']);
  const started = Date.now();

  while (Date.now() - started < maxWaitMs) {
    let response = await fetch(commonUrl, { method: 'GET', headers: baseHeaders });
    if (!response.ok) {
      response = await fetch(developerUrl, { method: 'GET', headers: developerHeaders });
    }
    if (response.ok) {
      const result = await response.json();
      const transactionData = result.data?.transaction || result.data;
      const state: string | undefined = transactionData?.state || result.data?.state;
      const hash: string | undefined =
        transactionData?.hash || transactionData?.txHash || transactionData?.transactionHash;

      if (state && failStates.has(state)) {
        return {
          transactionState: state,
          error: transactionData?.errorReason || transactionData?.errorDetails || `Circle transaction ${state}`,
        };
      }
      if (hash && state && okStates.has(state)) {
        return { txHash: hash, transactionState: state };
      }
      if (hash && (state === 'SENT' || state === 'CONFIRMING' || state === 'QUEUED')) {
        return { txHash: hash, transactionState: state };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return { error: 'Timed out waiting for Circle transaction confirmation' };
}

function normalizeTelegramId(telegramId: string | number | null | undefined) {
  if (telegramId === null || telegramId === undefined) return null;
  return String(telegramId).trim();
}

function normalizePrivyUserId(userId: string | null | undefined) {
  if (!userId) return null;
  return userId.startsWith('did:privy:') ? userId.replace('did:privy:', '') : userId;
}

async function verifyWalletOwnershipWithSignature(expectedAddresses: string | string[], message?: string, signature?: string) {
  if (!message || !signature) {
    return { success: false, reason: 'missing_signature' } as const;
  }

  const normalizedExpected = (Array.isArray(expectedAddresses) ? expectedAddresses : [expectedAddresses])
    .filter((address) => typeof address === 'string' && address.trim().length > 0)
    .map((address) => address.toLowerCase());

  if (normalizedExpected.length === 0) {
    return { success: false, reason: 'no_expected_addresses' } as const;
  }

  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (!recovered) {
      return { success: false, reason: 'no_recovered_address' } as const;
    }

    const normalizedRecovered = recovered.toLowerCase();
    const matchedAddress = normalizedExpected.find((expected) => expected === normalizedRecovered);

    return {
      success: Boolean(matchedAddress),
      reason: matchedAddress ? 'verified' : 'address_mismatch',
      recoveredAddress: normalizedRecovered,
      matchedAddress,
      expectedAddresses: normalizedExpected,
    } as const;
  } catch (error) {
    console.warn('Signature verification failed:', error);
    return { success: false, reason: 'verification_error', error: error instanceof Error ? error.message : String(error) } as const;
  }
}

interface PrivyCredentials {
  appId: string;
  secret: string;
}

function getPrivyCredentials(): PrivyCredentials | null {
  const appId = Deno.env.get('PRIVY_APP_ID');
  const secret = Deno.env.get('PRIVY_APP_SECRET') || Deno.env.get('PRIVY_API_KEY');

  if (!appId || !secret) {
    return null;
  }

  return { appId, secret };
}

// Helper: Re-encrypt Circle Entity Secret into fresh ciphertext (required per POST request)
// Uses RSA-OAEP with SHA-256 and the entity public key returned by Circle.
async function reEncryptEntitySecretCiphertextGlobal(circleApiKey: string, circleEntitySecret: string): Promise<string> {
  // Fetch entity public key
  const publicKeyResponse = await fetch('https://api.circle.com/v1/w3s/config/entity/publicKey', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${circleApiKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!publicKeyResponse.ok) {
    const errorText = await publicKeyResponse.text();
    throw new Error(`Failed to get public key: ${publicKeyResponse.status} ${errorText}`);
  }
  const publicKeyData = await publicKeyResponse.json();
  const entityPublicKey = publicKeyData.data?.publicKey;
  if (!entityPublicKey) {
    throw new Error('Failed to get entity public key from response');
  }

  // Convert hex secret to bytes
  const entitySecretBytes = new Uint8Array(
    circleEntitySecret.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
  );

  // Clean PEM/base64 wrappers and decode to DER (SPKI)
  const keyWithoutHeaders = entityPublicKey
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/-----BEGIN RSA PUBLIC KEY-----/g, '')
    .replace(/-----END RSA PUBLIC KEY-----/g, '')
    .replace(/\s/g, '')
    .replace(/\n/g, '')
    .replace(/\r/g, '');
  let publicKeyBuffer: Uint8Array;
  try {
    publicKeyBuffer = Uint8Array.from(atob(keyWithoutHeaders), c => c.charCodeAt(0));
  } catch (e) {
    throw new Error(`Failed to decode public key as base64. Error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Import public key and encrypt
  const publicKey = await crypto.subtle.importKey(
    'spki',
    publicKeyBuffer,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, entitySecretBytes);
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

async function fetchPrivyUserById(userId: string) {
  const credentials = getPrivyCredentials();

  if (!credentials) {
    return { success: false as const, reason: 'missing_credentials' as const };
  }

  const normalizedUserId = normalizePrivyUserId(userId);
  if (!normalizedUserId) {
    return { success: false as const, reason: 'invalid_user_id' as const };
  }

  const headers = {
    'Authorization': `Basic ${btoa(`${credentials.appId}:${credentials.secret}`)}`,
    'privy-app-id': credentials.appId,
    'Content-Type': 'application/json',
  } as const;

  const endpoints = [
    `https://auth.privy.io/api/v1/apps/${credentials.appId}/users/${normalizedUserId}`,
    `https://auth.privy.io/api/v1/users/${normalizedUserId}`
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { method: 'GET', headers });
      if (!response.ok) {
        const errorText = await response.text();
        console.warn('Privy API non-OK response:', response.status, errorText.substring(0, 200));
        continue;
      }

      const data = await response.json();
      return { success: true as const, user: data, endpoint };
    } catch (error) {
      console.error('Error fetching Privy user:', error);
    }
  }

  return { success: false as const, reason: 'not_found' as const };
}

// Helper function to verify social account ownership through Privy
async function verifySocialAccount(
  privyUser: any,
  platform: string,
  socialUserId: string
): Promise<{ verified: boolean; username?: string }> {
  // Extract linked accounts from Privy user data
  let linkedAccounts: any[] = [];
  
  if (Array.isArray(privyUser.linked_accounts)) {
    linkedAccounts = privyUser.linked_accounts;
  } else if (Array.isArray(privyUser.linkedAccounts)) {
    linkedAccounts = privyUser.linkedAccounts;
  } else if (Array.isArray(privyUser.accounts)) {
    linkedAccounts = privyUser.accounts;
  }

  // Find matching social account
  const socialAccount = linkedAccounts.find((account: any) => {
    const type = (account.type || '').toLowerCase();
    const provider = (account.provider || '').toLowerCase();
    const providerType = (account.providerType || '').toLowerCase();
    const subject = account.subject || account.id || account.userId;
    
    // Check if platform matches
    const platformMatch = 
      type === platform || 
      type === `${platform}_oauth` ||
      provider === platform || 
      provider === `${platform}_oauth` ||
      providerType === platform ||
      providerType === `${platform}_oauth`;
    
    // Check if social user ID matches
    const idMatch = subject === socialUserId || String(subject) === String(socialUserId);
    
    return platformMatch && idMatch;
  });

  if (!socialAccount) {
    return { verified: false };
  }

  return {
    verified: true,
    username: socialAccount.username || socialAccount.name
  };
}

const SOCIAL_WALLET_PLATFORMS = [
  'twitch',
  'twitter',
  'telegram',
  'tiktok',
  'instagram',
  'github',
  'gmail',
  'linkedin',
] as const;

async function verifyZkOAuthToken(
  platform: string,
  accessToken: string,
  socialUserId: string,
  oauth1TokenSecret?: string,
): Promise<boolean> {
  try {
    switch (platform) {
      case 'github': {
        const response = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { id?: number };
        return String(data.id) === String(socialUserId);
      }
      case 'gmail': {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { sub?: string };
        return data.sub === socialUserId;
      }
      case 'linkedin': {
        const response = await fetch('https://api.linkedin.com/v2/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { sub?: string };
        return data.sub === socialUserId;
      }
      case 'twitch': {
        const clientId = Deno.env.get('VITE_TWITCH_CLIENT_ID') || Deno.env.get('TWITCH_CLIENT_ID');
        if (!clientId) return false;
        const response = await fetch('https://api.twitch.tv/helix/users', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Client-Id': clientId,
          },
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { data?: Array<{ id?: string }> };
        return String(data.data?.[0]?.id) === String(socialUserId);
      }
      case 'telegram': {
        const baseUrl = (Deno.env.get('ZKTLS_SERVICE_URL') || '').replace(/\/$/, '');
        if (!baseUrl) return false;
        const response = await fetch(`${baseUrl}/api/telegram/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { telegram_user_id?: string | number; id?: string | number };
        const resolvedId = data.telegram_user_id ?? data.id;
        return resolvedId != null && String(resolvedId) === String(socialUserId);
      }
      case 'twitter': {
        const response = await fetch('https://api.x.com/2/users/me?user.fields=id', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (response.ok) {
          const data = (await response.json()) as { data?: { id?: string } };
          return String(data.data?.id) === String(socialUserId);
        }
        if (oauth1TokenSecret && accessToken.length > 10 && oauth1TokenSecret.length > 10) {
          return /^\d+$/.test(socialUserId);
        }
        return false;
      }
      default:
        return false;
    }
  } catch (error) {
    console.warn('[verifyZkOAuthToken] Verification failed:', platform, error);
    return false;
  }
}

function extractPrivyWalletAddresses(userData: any): string[] {
  const addresses = new Set<string>();

  if (!userData) {
    return [];
  }

  const maybeAddAddress = (value: any) => {
    if (typeof value === 'string' && value.startsWith('0x') && value.length === 42) {
      addresses.add(value.toLowerCase());
    }
  };

  const walletsSources = [
    userData.wallets,
    userData.accounts,
    userData.linked_accounts,
    userData.linkedAccounts,
    userData.data,
  ];

  for (const source of walletsSources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type && typeof entry.type === 'string' && entry.type.toLowerCase().includes('wallet')) {
        maybeAddAddress(entry.address || entry.walletAddress || entry.subject || entry.pubkey || entry.publicAddress);
      }
      if (entry.address) {
        maybeAddAddress(entry.address);
      }
      if (entry.wallet && entry.wallet.address) {
        maybeAddAddress(entry.wallet.address);
      }
      if (entry.publicAddress) {
        maybeAddAddress(entry.publicAddress);
      }
    }
  }

  if (userData.wallet && typeof userData.wallet === 'object') {
    maybeAddAddress(userData.wallet.address);
  }

  return Array.from(addresses);
}

function extractPrivyTelegramIds(userData: any): string[] {
  const ids = new Set<string>();

  const maybeAdd = (value: any) => {
    if (value === null || value === undefined) return;
    const normalized = String(value).trim();
    if (normalized.length > 0) {
      ids.add(normalized);
    }
  };

  if (!userData) {
    return [];
  }

  if (userData.telegram) {
    maybeAdd(userData.telegram.telegramUserId || userData.telegram.id || userData.telegram.telegram_user_id);
  }

  const linkedSources = [
    userData.linked_accounts,
    userData.linkedAccounts,
    userData.accounts,
    userData.data,
  ];

  for (const source of linkedSources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (!entry || typeof entry !== 'object') continue;
      const type = (entry.type || entry.provider || entry.providerType || '').toString().toLowerCase();
      if (type.includes('telegram')) {
        maybeAdd(entry.telegramUserId || entry.subject || entry.id || entry.identifier);
      }
    }
  }

  return Array.from(ids);
}

async function verifyWalletOwnershipWithPrivy(userId: string, walletAddress: string) {
  const fetchResult = await fetchPrivyUserById(userId);

  if (!fetchResult.success) {
    return { success: false as const, reason: fetchResult.reason };
  }

  const addresses = extractPrivyWalletAddresses(fetchResult.user);
  const normalizedWallet = walletAddress.toLowerCase();
  const matched = addresses.includes(normalizedWallet);

  return {
    success: matched as const,
    reason: matched ? 'verified' as const : 'address_not_found' as const,
    addresses,
    user: fetchResult.user,
    endpoint: fetchResult.endpoint,
  };
}

// Sign up endpoint
app.post('/signup', async (c) => {
  try {
    const { email, password, name } = await c.req.json();
    
    const client = getSupabaseClient();
    const { data, error } = await client.auth.admin.createUser({
      email,
      password,
      user_metadata: { name },
      // Automatically confirm the user's email since an email server hasn't been configured.
      email_confirm: true
    });

    if (error) {
      console.log(`Signup error: ${error.message}`);
      return c.json({ error: error.message }, 400);
    }

    return c.json({ user: data.user });
  } catch (error) {
    console.log(`Server error during signup: ${error}`);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Create gift card endpoint
app.post('/gift-cards', async (c) => {
  try {
    // TODO: Add authentication when auth system is ready
    // const { user, error: authError } = await verifyUser(c.req.raw);
    // if (!user) {
    //   return c.json({ error: 'Unauthorized' }, 401);
    // }

    const cardData = await c.req.json();
    const cardId = `GIFT${Date.now()}${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    
    const giftCard = {
      id: cardId,
      sender_id: 'temp_user', // TODO: Replace with actual user ID
      sender_address: cardData.senderAddress,
      recipient_address: cardData.recipientAddress,
      amount: cardData.amount,
      currency: cardData.currency,
      design: cardData.design,
      message: cardData.message,
      secret_message: cardData.secretMessage || '',
      has_timer: cardData.hasTimer || false,
      timer_hours: cardData.timerHours || 0,
      has_password: cardData.hasPassword || false,
      password_hash: cardData.password ? await hashPassword(cardData.password) : '',
      expiry_days: cardData.expiryDays || 7,
      custom_image: cardData.customImage || '',
      nft_cover: cardData.nftCover || '',
      status: 'active',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + (cardData.expiryDays || 7) * 24 * 60 * 60 * 1000).toISOString(),
      qr_code: `sendly://redeem/${cardId}`,
      tx_hash: cardData.txHash || ''
    };

    await kv.set(`gift_card:${cardId}`, giftCard);
    await kv.set(`user_sent:temp_user:${cardId}`, { card_id: cardId, created_at: giftCard.created_at });
    
    // Add to analytics
    const userStats = await kv.get(`user_stats:temp_user`) || { 
      total_sent: 0, 
      total_received: 0, 
      cards_sent: 0, 
      cards_received: 0 
    };
    userStats.total_sent += parseFloat(cardData.amount);
    userStats.cards_sent += 1;
    await kv.set(`user_stats:temp_user`, userStats);

    const chainId = getChainIdFromRequest(c.req.query(), cardData);
    await recordLeaderboardSend({
      chainId,
      senderAddress: cardData.senderAddress,
      userIdentifier: cardData.senderAddress || giftCard.sender_id,
      platform: 'direct',
      displayName: cardData.senderAddress || giftCard.sender_id,
      amount: cardData.amount,
      currency: cardData.currency,
      recipientHandle: cardData.recipientAddress,
    });

    return c.json({ card: giftCard });
  } catch (error) {
    console.log(`Error creating gift card: ${error}`);
    return c.json({ error: 'Failed to create gift card' }, 500);
  }
});

// Get user's gift cards
app.get('/gift-cards', async (c) => {
  try {
    // TODO: Add authentication when auth system is ready
    // const { user, error: authError } = await verifyUser(c.req.raw);
    // if (!user) {
    //   return c.json({ error: 'Unauthorized' }, 401);
    // }

    const type = c.req.query('type') || 'sent';
    const prefix = type === 'sent' ? `user_sent:temp_user:` : `user_received:temp_user:`;
    
    const cardRefs = await kv.getByPrefix(prefix);
    const cards = [];
    
    for (const ref of cardRefs) {
      const card = await kv.get(`gift_card:${ref.card_id}`);
      if (card) {
        cards.push(card);
      }
    }

    return c.json({ cards: cards.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) });
  } catch (error) {
    console.log(`Error fetching gift cards: ${error}`);
    return c.json({ error: 'Failed to fetch gift cards' }, 500);
  }
});

app.get('/leaderboard/senders', async (c) => {
  try {
    const client = getSupabaseClient();
    const limitParam = c.req.query('limit');
    const rawPlatformParam = (c.req.query('platform') || 'all').toLowerCase();
    const tableParam = c.req.query('table'); // Support ?table=stats|graph_true|both
    const tableName = getLeaderboardTableName(tableParam);
    const chainId = getChainIdFromRequest(c.req.query(), undefined);
    
    // If limit is not specified or very large (> 10000), load all records
    const hasLimit = limitParam !== undefined && limitParam !== '';
    const limitValue = hasLimit ? parseInt(limitParam, 10) : null;
    const limit = limitValue && Number.isFinite(limitValue) && limitValue > 0 && limitValue <= 100000 
      ? limitValue 
      : null; // null means "no limit"
    const isAllPlatforms = rawPlatformParam === 'all';
    // If limit is not specified, use a large number for fetchLimit (Supabase may have its own limits)
    const fetchLimit = limit !== null ? (isAllPlatforms ? limit * 5 : limit) : 100000;
    
    console.log(`[Leaderboard] Request params: limitParam=${limitParam}, limit=${limit}, fetchLimit=${fetchLimit}, platform=${rawPlatformParam}, table=${tableName}, chainId=${chainId}`);

    // Supabase limits results to 1000 records per query
    // Use pagination to load all records if we need more than 1000
    const SUPABASE_MAX_LIMIT = 1000;
    const needsPagination = fetchLimit >= 100000 || fetchLimit > SUPABASE_MAX_LIMIT;
    
    let allData: any[] = [];
    
    // Helper function to fetch data from a specific table
    const fetchFromTable = async (table: string): Promise<any[]> => {
      const tableData: any[] = [];
      
      if (needsPagination) {
        let offset = 0;
        const pageSize = SUPABASE_MAX_LIMIT;
        
        while (true) {
          const buildQuery = (withChain: boolean) => {
            let q = client
              .from(table)
              .select('id,user_identifier,sender_address,social_platform,display_name,avatar_url,last_recipient,cards_sent_total,amount_sent_total,amount_sent_by_currency,last_sent_at,zns_domain')
              .order('cards_sent_total', { ascending: false })
              .order('amount_sent_total', { ascending: false })
              .range(offset, offset + pageSize - 1);
            if (withChain) {
              q = q.eq('chain_id', chainId);
            }
            if (!isAllPlatforms) {
              q = q.eq('social_platform', rawPlatformParam);
            }
            return q;
          };

          let data: any[] | null = null;
          let error: any = null;
          ({ data, error } = await buildQuery(true));
          if (error && isMissingChainIdColumnError(error)) {
            console.warn(`[Leaderboard] chain_id missing on ${table}; falling back to legacy query`);
            ({ data, error } = await buildQuery(false));
          }
          if (error) {
            throw error;
          }

          if (!data || data.length === 0) {
            break;
          }

          tableData.push(...data);

          if (data.length < pageSize) {
            break;
          }

          if (fetchLimit < 100000 && tableData.length >= fetchLimit) {
            tableData.splice(fetchLimit);
            break;
          }

          offset += pageSize;
        }
      } else {
        const buildQuery = (withChain: boolean) => {
          let q = client
            .from(table)
            .select('id,user_identifier,sender_address,social_platform,display_name,avatar_url,last_recipient,cards_sent_total,amount_sent_total,amount_sent_by_currency,last_sent_at,zns_domain')
            .order('cards_sent_total', { ascending: false })
            .order('amount_sent_total', { ascending: false })
            .limit(fetchLimit);
          if (withChain) {
            q = q.eq('chain_id', chainId);
          }
          if (!isAllPlatforms) {
            q = q.eq('social_platform', rawPlatformParam);
          }
          return q;
        };

        let data: any[] | null = null;
        let error: any = null;
        ({ data, error } = await buildQuery(true));
        if (error && isMissingChainIdColumnError(error)) {
          console.warn(`[Leaderboard] chain_id missing on ${table}; falling back to legacy query`);
          ({ data, error } = await buildQuery(false));
        }
        if (error) {
          throw error;
        }

        if (data) {
          tableData.push(...data);
        }
      }
      
      return tableData;
    };
    
    // Fetch data based on table selection
    if (tableName === 'both') {
      // Fetch from both tables and merge
      const [statsData, graphData] = await Promise.all([
        fetchFromTable('leaderboard_stats'),
        fetchFromTable('leaderboard_stats_graph_true')
      ]);
      
      // Merge and deduplicate by (user_identifier, sender_address, social_platform)
      const mergedMap = new Map<string, any>();
      
      const addToMap = (row: any) => {
        const key = `${row.user_identifier || ''}_${row.sender_address || ''}_${row.social_platform || ''}`;
        const existing = mergedMap.get(key);
        
        if (!existing) {
          mergedMap.set(key, { ...row });
        } else {
          // Merge: take max values and latest dates
          existing.cards_sent_total = Math.max(existing.cards_sent_total || 0, row.cards_sent_total || 0);
          existing.amount_sent_total = Math.max(
            parseFloat(existing.amount_sent_total || '0'),
            parseFloat(row.amount_sent_total || '0')
          );
          
          // Merge currency maps
          const existingCurrencies = existing.amount_sent_by_currency || {};
          const rowCurrencies = row.amount_sent_by_currency || {};
          const mergedCurrencies: Record<string, number> = { ...existingCurrencies };
          for (const [currency, amount] of Object.entries(rowCurrencies)) {
            mergedCurrencies[currency] = Math.max(
              mergedCurrencies[currency] || 0,
              parseFloat(String(amount)) || 0
            );
          }
          existing.amount_sent_by_currency = mergedCurrencies;
          
          // Take latest last_sent_at
          const existingDate = existing.last_sent_at ? new Date(existing.last_sent_at).getTime() : 0;
          const rowDate = row.last_sent_at ? new Date(row.last_sent_at).getTime() : 0;
          if (rowDate > existingDate) {
            existing.last_sent_at = row.last_sent_at;
            existing.last_recipient = row.last_recipient || existing.last_recipient;
          }
          
          // Prefer non-null values for display fields
          if (!existing.display_name && row.display_name) existing.display_name = row.display_name;
          if (!existing.avatar_url && row.avatar_url) existing.avatar_url = row.avatar_url;
          if (!existing.zns_domain && row.zns_domain) existing.zns_domain = row.zns_domain;
        }
      };
      
      statsData.forEach(addToMap);
      graphData.forEach(addToMap);
      
      allData = Array.from(mergedMap.values())
        .sort((a, b) => {
          const aCards = a.cards_sent_total || 0;
          const bCards = b.cards_sent_total || 0;
          if (bCards !== aCards) return bCards - aCards;
          const aAmount = parseFloat(a.amount_sent_total || '0');
          const bAmount = parseFloat(b.amount_sent_total || '0');
          return bAmount - aAmount;
        });
      
      if (fetchLimit < 100000 && allData.length > fetchLimit) {
        allData = allData.slice(0, fetchLimit);
      }
    } else {
      // Fetch from single table
      allData = await fetchFromTable(tableName);
    }

    const data = allData;
    console.log(`[Leaderboard] Fetched ${data?.length || 0} rows from database (requested limit: ${fetchLimit}, pagination used: ${needsPagination})`);

    let entries: LeaderboardRow[] = (data || []).map((row: any) => ({
      id: row.id,
      userIdentifier: row.user_identifier,
      senderAddress: row.sender_address,
      socialPlatform: row.social_platform,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      lastRecipient: null,
      cardsSentTotal: row.cards_sent_total ?? 0,
      amountSentTotal: parseNumericValue(row.amount_sent_total),
      amountSentByCurrency: normalizeCurrencyMap(row.amount_sent_by_currency),
      lastSentAt: row.last_sent_at,
      znsDomain: row.zns_domain ?? null,
    }));

    if (isAllPlatforms) {
      // If limit >= 100000, treat as "no limit" and use array length
      const aggregationLimit = (limit !== null && limit >= 100000) ? entries.length : (limit || entries.length);
      entries = aggregateLeaderboardRows(entries, aggregationLimit);
    } else {
      // Apply limit only if specified and less than 100000
      if (limit !== null && limit < 100000) {
        entries = entries.slice(0, limit);
      }
    }

    console.log(`[Leaderboard] Returning ${entries.length} entries (limit: ${limit})`);

    return c.json({ entries });
  } catch (error) {
    console.error('Failed to fetch leaderboard stats:', error);
    return c.json({ error: 'Failed to fetch leaderboard' }, 500);
  }
});

// Get leaderboard from leaderboard_stats_graph_true table
app.get('/leaderboard/senders-graph', async (c) => {
  try {
    const client = getSupabaseClient();
    const limitParam = c.req.query('limit');
    const chainId = getChainIdFromRequest(c.req.query(), undefined);
    
    // If limit is not specified or very large (> 10000), load all records
    const hasLimit = limitParam !== undefined && limitParam !== '';
    const limitValue = hasLimit ? parseInt(limitParam, 10) : null;
    const limit = limitValue && Number.isFinite(limitValue) && limitValue > 0 && limitValue <= 100000 
      ? limitValue 
      : null; // null means "no limit"
    // If limit is not specified, use a large number for fetchLimit (Supabase may have its own limits)
    const fetchLimit = limit !== null ? limit : 100000;
    
    console.log(`[Leaderboard Graph True] Request params: limitParam=${limitParam}, limit=${limit}, fetchLimit=${fetchLimit}, chainId=${chainId}`);

    // Supabase limits results to 1000 records per query
    // Use pagination to load all records if we need more than 1000
    const SUPABASE_MAX_LIMIT = 1000;
    const needsPagination = fetchLimit >= 100000 || fetchLimit > SUPABASE_MAX_LIMIT;
    
    const graphTrueColumns =
      'id,user_identifier,sender_address,social_platform,display_name,avatar_url,last_recipient,cards_sent_total,amount_sent_total,amount_sent_by_currency,last_sent_at,zns_domain';

    const orderedSelect = (query: any, filterByChain: boolean) => {
      let q = query.from('leaderboard_stats_graph_true').select(graphTrueColumns);
      if (filterByChain) {
        q = q.eq('chain_id', chainId);
      }
      return q
        .order('cards_sent_total', { ascending: false })
        .order('amount_sent_total', { ascending: false });
    };

    const fetchGraphTrueRows = async (filterByChain: boolean): Promise<{ data: any[]; error: any }> => {
      const rows: any[] = [];
      if (needsPagination) {
        let offset = 0;
        const pageSize = SUPABASE_MAX_LIMIT;
        while (true) {
          const { data, error } = await orderedSelect(client, filterByChain).range(
            offset,
            offset + pageSize - 1
          );
          if (error) return { data: [], error };
          if (!data || data.length === 0) break;
          rows.push(...data);
          if (data.length < pageSize) break;
          if (fetchLimit < 100000 && rows.length >= fetchLimit) {
            rows.splice(fetchLimit);
            break;
          }
          offset += pageSize;
        }
        return { data: rows, error: null };
      }
      const { data, error } = await orderedSelect(client, filterByChain).limit(fetchLimit);
      if (error) return { data: [], error };
      return { data: data || [], error: null };
    };

    let fetchResult = await fetchGraphTrueRows(true);
    if (fetchResult.error && isMissingChainIdColumnError(fetchResult.error)) {
      console.warn(
        '[Leaderboard Graph True] chain_id missing on leaderboard_stats_graph_true; retrying without filter. Apply migration 038_add_chain_id_to_leaderboard_stats_graph_true.sql'
      );
      fetchResult = await fetchGraphTrueRows(false);
    }
    if (fetchResult.error) {
      throw fetchResult.error;
    }
    const allData = fetchResult.data;

    // Transform data to match expected format
    const entries = allData.map((row) => ({
      id: row.id,
      userIdentifier: row.user_identifier || '',
      senderAddress: row.sender_address || '',
      socialPlatform: row.social_platform || 'address',
      displayName: row.display_name || null,
      avatarUrl: row.avatar_url || null,
      lastRecipient: row.last_recipient || null,
      cardsSentTotal: row.cards_sent_total || 0,
      amountSentTotal: parseFloat(row.amount_sent_total || '0'),
      amountSentByCurrency: row.amount_sent_by_currency || {},
      lastSentAt: row.last_sent_at || null,
      znsDomain: row.zns_domain || null,
    }));

    // Apply limit if specified
    const finalEntries = limit !== null && entries.length > limit ? entries.slice(0, limit) : entries;

    console.log(`[Leaderboard Graph True] Returning ${finalEntries.length} entries (limit: ${limit})`);

    return c.json({ entries: finalEntries });
  } catch (error) {
    console.error('Failed to fetch leaderboard stats from leaderboard_stats_graph_true:', error);
    return c.json({ error: 'Failed to fetch leaderboard' }, 500);
  }
});

// Recalculate leaderboard from gift_cards table
app.post('/leaderboard/recalculate', async (c) => {
  try {
    const client = getSupabaseClient();
    
    console.log('[Recalculate] Starting leaderboard recalculation...');
    console.log('[Recalculate] Request received at:', new Date().toISOString());
    
    // Call the SQL function to recalculate
    console.log('[Recalculate] Calling recalculate_leaderboard_stats()...');
    const { data, error } = await client.rpc('recalculate_leaderboard_stats');
    
    if (error) {
      console.error('[Recalculate] Error recalculating leaderboard:', JSON.stringify(error, null, 2));
      console.error('[Recalculate] Error code:', error.code);
      console.error('[Recalculate] Error message:', error.message);
      console.error('[Recalculate] Error details:', error.details);
      console.error('[Recalculate] Error hint:', error.hint);
      console.error('[Recalculate] Full error object:', error);
      
      // Try to get more info about the error
      const errorInfo: any = {
        message: error.message || 'Unknown error',
        code: error.code,
        details: error.details,
        hint: error.hint,
      };
      
      // If function doesn't exist, suggest applying migration
      if (error.message?.includes('function') || error.code === '42883') {
        errorInfo.suggestion = 'SQL function recalculate_leaderboard_stats may not exist. Please apply migration 020_fix_recalculate_leaderboard_robust.sql';
      }
      
      return c.json({ 
        error: 'Failed to recalculate leaderboard',
        details: errorInfo.message,
        code: errorInfo.code,
        hint: errorInfo.hint,
        suggestion: errorInfo.suggestion,
        full_error: errorInfo
      }, 500);
    }
    
    console.log('[Recalculate] SQL function executed successfully');
    
    // Get stats count
    console.log('[Recalculate] Getting stats count...');
    const { count, error: countError } = await client
      .from('leaderboard_stats')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('[Recalculate] Error getting stats count:', countError);
      // Don't fail the request if count fails, just log it
    }
    
    console.log('[Recalculate] Leaderboard recalculation completed. Entries:', count);
    
    return c.json({
      success: true,
      message: 'Leaderboard recalculated successfully',
      entries_count: count || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Recalculate] Failed to recalculate leaderboard (catch block):', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    console.error('[Recalculate] Error stack:', errorStack);
    console.error('[Recalculate] Error type:', typeof error);
    console.error('[Recalculate] Error constructor:', error?.constructor?.name);
    
    return c.json({ 
      error: 'Failed to recalculate leaderboard',
      details: errorMessage,
      stack: errorStack,
      type: typeof error
    }, 500);
  }
});

// Recalculate leaderboard_stats_graph_true from gift_cards_graph table
app.post('/leaderboard/recalculate-graph-true', async (c) => {
  try {
    const client = getSupabaseClient();
    
    console.log('[Recalculate Graph True] Starting leaderboard recalculation...');
    console.log('[Recalculate Graph True] Request received at:', new Date().toISOString());
    
    // Call the SQL function to recalculate
    console.log('[Recalculate Graph True] Calling recalculate_leaderboard_stats_graph_true()...');
    const { data, error } = await client.rpc('recalculate_leaderboard_stats_graph_true');
    
    if (error) {
      console.error('[Recalculate Graph True] Error recalculating leaderboard:', JSON.stringify(error, null, 2));
      console.error('[Recalculate Graph True] Error code:', error.code);
      console.error('[Recalculate Graph True] Error message:', error.message);
      console.error('[Recalculate Graph True] Error details:', error.details);
      console.error('[Recalculate Graph True] Error hint:', error.hint);
      
      const errorInfo: any = {
        message: error.message || 'Unknown error',
        code: error.code,
        details: error.details,
        hint: error.hint,
      };
      
      if (isChainIdSchemaErrorEdge(error)) {
        errorInfo.suggestion = LEADERBOARD_GRAPH_TRUE_CHAIN_ID_MIGRATION_HINT;
      } else if (error.message?.includes('function') || error.code === '42883') {
        errorInfo.suggestion = 'SQL function recalculate_leaderboard_stats_graph_true may not exist. Please apply migration 031_recalculate_leaderboard_stats_graph_true.sql';
      }
      
      return c.json({ 
        error: 'Failed to recalculate leaderboard_stats_graph_true',
        details: errorInfo.message,
        code: errorInfo.code,
        hint: errorInfo.hint,
        suggestion: errorInfo.suggestion,
        full_error: errorInfo
      }, 500);
    }
    
    console.log('[Recalculate Graph True] SQL function executed successfully');
    
    // Get stats count
    console.log('[Recalculate Graph True] Getting stats count...');
    const { count, error: countError } = await client
      .from('leaderboard_stats_graph_true')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('[Recalculate Graph True] Error getting count:', countError);
    }
    
    console.log(`[Recalculate Graph True] Recalculation completed. Total stats: ${count || 0}`);
    
    return c.json({
      success: true,
      message: 'Leaderboard stats_graph_true recalculated successfully',
      entries_count: count || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Recalculate Graph True] Failed to recalculate leaderboard (catch block):', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    return c.json({ 
      error: 'Failed to recalculate leaderboard_stats_graph_true',
      details: errorMessage,
      stack: errorStack,
    }, 500);
  }
});

// Sync leaderboard_stats_graph_true from subgraph
app.post('/leaderboard/sync-from-subgraph', async (c) => {
  try {
    const client = getSupabaseClient();
    const subgraphUrl = Deno.env.get('SUBGRAPH_URL');
    
    if (!subgraphUrl) {
      return c.json({ 
        error: 'SUBGRAPH_URL environment variable is not set',
        hint: 'Please set SUBGRAPH_URL in Supabase Dashboard → Edge Functions → Functions Secrets'
      }, 400);
    }
    
    console.log('[Subgraph Sync] Starting sync from subgraph:', subgraphUrl);
    
    // GraphQL query to fetch gift card transfers from subgraph
    // Adjust this query based on your subgraph schema
    const query = `
      query GetGiftCardTransfers($first: Int!, $skip: Int!) {
        giftCardTransfers(
          first: $first
          skip: $skip
          orderBy: timestamp
          orderDirection: desc
        ) {
          id
          tokenId
          from
          to
          amount
          currency
          timestamp
          blockNumber
          transactionHash
          platform
          recipientUsername
          senderUsername
        }
      }
    `;
    
    let allTransfers: any[] = [];
    let skip = 0;
    const batchSize = 1000;
    let hasMore = true;
    
    // Fetch all transfers from subgraph in batches
    while (hasMore) {
      const variables = {
        first: batchSize,
        skip: skip
      };
      
      console.log(`[Subgraph Sync] Fetching batch: skip=${skip}, first=${batchSize}`);
      
      const response = await fetch(subgraphUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Subgraph API error: ${response.status} ${errorText}`);
      }
      
      const result = await response.json();
      
      if (result.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
      }
      
      const transfers = result.data?.giftCardTransfers || [];
      allTransfers.push(...transfers);
      
      console.log(`[Subgraph Sync] Fetched ${transfers.length} transfers (total: ${allTransfers.length})`);
      
      if (transfers.length < batchSize) {
        hasMore = false;
      } else {
        skip += batchSize;
      }
      
      // Safety limit to prevent infinite loops
      if (skip > 100000) {
        console.warn('[Subgraph Sync] Reached safety limit of 100k transfers');
        break;
      }
    }
    
    console.log(`[Subgraph Sync] Total transfers fetched: ${allTransfers.length}`);
    
    // Aggregate transfers by (sender_address, user_identifier, social_platform)
    const statsMap = new Map<string, {
      user_identifier: string;
      sender_address: string;
      social_platform: string;
      display_name: string | null;
      avatar_url: string | null;
      last_recipient: string | null;
      cards_sent_total: number;
      amount_sent_total: number;
      amount_sent_by_currency: Record<string, number>;
      last_sent_at: string | null;
    }>();
    
    for (const transfer of allTransfers) {
      const senderAddress = (transfer.from || '').toLowerCase();
      const platform = (transfer.platform || 'generic').toLowerCase();
      const userIdentifier = transfer.senderUsername || senderAddress || 'anonymous';
      const key = `${userIdentifier}_${senderAddress}_${platform}`;
      
      if (!senderAddress) {
        continue; // Skip transfers without sender
      }
      
      const amount = parseFloat(transfer.amount || '0');
      const currency = (transfer.currency || 'USDC').toUpperCase();
      const timestamp = transfer.timestamp ? new Date(parseInt(transfer.timestamp) * 1000).toISOString() : null;
      
      let stats = statsMap.get(key);
      
      if (!stats) {
        stats = {
          user_identifier: userIdentifier,
          sender_address: senderAddress,
          social_platform: platform,
          display_name: transfer.senderUsername || senderAddress,
          avatar_url: null,
          last_recipient: transfer.recipientUsername || null,
          cards_sent_total: 0,
          amount_sent_total: 0,
          amount_sent_by_currency: {},
          last_sent_at: null,
        };
        statsMap.set(key, stats);
      }
      
      stats.cards_sent_total += 1;
      stats.amount_sent_total += amount;
      stats.amount_sent_by_currency[currency] = (stats.amount_sent_by_currency[currency] || 0) + amount;
      
      // Update last_sent_at if this transfer is more recent
      if (timestamp) {
        const currentTime = stats.last_sent_at ? new Date(stats.last_sent_at).getTime() : 0;
        const transferTime = new Date(timestamp).getTime();
        if (transferTime > currentTime) {
          stats.last_sent_at = timestamp;
          stats.last_recipient = transfer.recipientUsername || stats.last_recipient;
        }
      }
      
      // Update display_name if available
      if (transfer.senderUsername && !stats.display_name) {
        stats.display_name = transfer.senderUsername;
      }
    }
    
    console.log(`[Subgraph Sync] Aggregated ${statsMap.size} unique sender stats`);
    
    // Upsert stats into leaderboard_stats_graph_true
    const statsArray = Array.from(statsMap.values());
    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let errors = 0;
    
    // Process in batches to avoid overwhelming the database
    const dbBatchSize = 100;
    for (let i = 0; i < statsArray.length; i += dbBatchSize) {
      const batch = statsArray.slice(i, i + dbBatchSize);
      
      const upserts = batch.map(stat => ({
        user_identifier: stat.user_identifier,
        sender_address: stat.sender_address,
        social_platform: stat.social_platform,
        display_name: stat.display_name || stat.sender_address,
        avatar_url: stat.avatar_url,
        last_recipient: stat.last_recipient,
        cards_sent_total: stat.cards_sent_total,
        amount_sent_total: stat.amount_sent_total.toString(),
        amount_sent_by_currency: stat.amount_sent_by_currency,
        last_sent_at: stat.last_sent_at,
        updated_at: now,
      }));
      
      // Check existing records to determine insert vs update
      for (const upsert of upserts) {
        const { data: existing } = await client
          .from('leaderboard_stats_graph_true')
          .select('id')
          .eq('user_identifier', upsert.user_identifier)
          .eq('sender_address', upsert.sender_address)
          .eq('social_platform', upsert.social_platform)
          .maybeSingle();
        
        const { error } = await client
          .from('leaderboard_stats_graph_true')
          .upsert(upsert, {
            onConflict: 'user_identifier,sender_address,social_platform'
          });
        
        if (error) {
          console.error(`[Subgraph Sync] Error upserting stat:`, error);
          errors++;
        } else {
          if (existing) {
            updated++;
          } else {
            inserted++;
          }
        }
      }
      
      console.log(`[Subgraph Sync] Processed batch ${Math.floor(i / dbBatchSize) + 1}/${Math.ceil(statsArray.length / dbBatchSize)}`);
    }
    
    // Get final count
    const { count } = await client
      .from('leaderboard_stats_graph_true')
      .select('*', { count: 'exact', head: true });
    
    console.log(`[Subgraph Sync] Sync completed. Inserted: ${inserted}, Updated: ${updated}, Errors: ${errors}, Total records: ${count}`);
    
    return c.json({
      success: true,
      message: 'Successfully synced leaderboard from subgraph',
      stats: {
        transfers_fetched: allTransfers.length,
        unique_senders: statsMap.size,
        inserted,
        updated,
        errors,
        total_records: count || 0
      },
      timestamp: now
    });
  } catch (error) {
    console.error('[Subgraph Sync] Failed to sync from subgraph:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to sync from subgraph',
      details: errorMessage
    }, 500);
  }
});

// Sync leaderboard_stats_graph_true from gift_cards_graph table
app.post('/leaderboard/sync-graph', async (c) => {
  try {
    const client = getSupabaseClient();
    
    console.log('[Sync Graph] Starting sync of leaderboard_stats_graph_true...');
    console.log('[Sync Graph] Request received at:', new Date().toISOString());
    
    // Call the SQL function to recalculate/sync
    console.log('[Sync Graph] Calling recalculate_leaderboard_stats_graph_true()...');
    const { data, error } = await client.rpc('recalculate_leaderboard_stats_graph_true');
    
    if (error) {
      console.error('[Sync Graph] Error syncing leaderboard:', JSON.stringify(error, null, 2));
      console.error('[Sync Graph] Error code:', error.code);
      console.error('[Sync Graph] Error message:', error.message);
      console.error('[Sync Graph] Error details:', error.details);
      console.error('[Sync Graph] Error hint:', error.hint);
      
      const errorInfo: any = {
        message: error.message || 'Unknown error',
        code: error.code,
        details: error.details,
        hint: error.hint,
      };
      
      if (isChainIdSchemaErrorEdge(error)) {
        errorInfo.suggestion = LEADERBOARD_GRAPH_TRUE_CHAIN_ID_MIGRATION_HINT;
      } else if (error.message?.includes('function') || error.code === '42883') {
        errorInfo.suggestion = 'SQL function recalculate_leaderboard_stats_graph_true may not exist. Please apply migration 031_recalculate_leaderboard_stats_graph_true.sql';
      }
      
      return c.json({ 
        success: false,
        error: 'Failed to sync leaderboard_stats_graph_true',
        details: errorInfo.message,
        code: errorInfo.code,
        hint: errorInfo.hint,
        suggestion: errorInfo.suggestion,
        full_error: errorInfo
      }, 500);
    }
    
    console.log('[Sync Graph] SQL function executed successfully');
    
    // Get stats count
    console.log('[Sync Graph] Getting stats count...');
    const { count, error: countError } = await client
      .from('leaderboard_stats_graph_true')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('[Sync Graph] Error getting count:', countError);
      // Don't fail the request if count fails, just log it
    }
    
    console.log(`[Sync Graph] Sync completed. Total stats: ${count || 0}`);
    
    return c.json({
      success: true,
      message: 'Leaderboard stats_graph_true synced successfully',
      entries_count: count || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Sync Graph] Failed to sync leaderboard (catch block):', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    return c.json({ 
      success: false,
      error: 'Failed to sync leaderboard_stats_graph_true',
      details: errorMessage,
      stack: errorStack,
    }, 500);
  }
});

// Update ZNS domains for leaderboard_stats_graph_true table
app.post('/leaderboard/update-zns-domains-graph', async (c) => {
  try {
    const client = getSupabaseClient();
    const ZNS_API_BASE_URL = 'https://zns.bio/api';
    const ARC_TESTNET_CHAIN_ID = 5042002; // ARC Testnet only
    
    console.log('[Update ZNS Graph] Starting ZNS domains update for leaderboard_stats_graph_true...');
    
    // Get all unique sender addresses from leaderboard_stats_graph_true
    const { data: addressesData, error: fetchError } = await client
      .from('leaderboard_stats_graph_true')
      .select('sender_address')
      .not('sender_address', 'is', null);
    
    if (fetchError) {
      throw fetchError;
    }
    
    // Extract unique addresses and normalize them
    const uniqueAddresses = [...new Set(
      (addressesData || [])
        .map((row: any) => {
          const addr = row.sender_address;
          return addr && addr.startsWith('0x') ? addr.toLowerCase() : null;
        })
        .filter((addr: string | null) => addr !== null) as string[]
    )];
    
    console.log(`[Update ZNS Graph] Found ${uniqueAddresses.length} unique addresses to check`);
    
    let updatedCount = 0;
    let foundCount = 0;
    const batchSize = 5;
    const delayBetweenBatches = 200;
    
    // Helper function to resolve ZNS domain on ARC Testnet
    async function resolveZNSDomain(address: string): Promise<string | null> {
      try {
        const url = `${ZNS_API_BASE_URL}/resolveAddress?chain=${ARC_TESTNET_CHAIN_ID}&address=${address}`;
        const response = await fetch(url);
        
        if (!response.ok) {
          return null;
        }
        
        const data = await response.json();
        
        if (data.code === 200 && data.primaryDomain && data.primaryDomain.trim()) {
          return data.primaryDomain.trim();
        }
        
        return null;
      } catch (error) {
        return null;
      }
    }
    
    // Process addresses in batches
    for (let i = 0; i < uniqueAddresses.length; i += batchSize) {
      const batch = uniqueAddresses.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (address: string) => {
        try {
          const domain = await resolveZNSDomain(address);
          return { address, domain };
        } catch (error) {
          return { address, domain: null };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      
      // Update database for addresses with domains
      for (const { address, domain } of batchResults) {
        if (domain) {
          try {
            const normalizedAddress = address.toLowerCase();
            
            // Try to update using normalized address
            const { data: updateData, error: updateError } = await client
              .from('leaderboard_stats_graph_true')
              .update({ zns_domain: domain, updated_at: new Date().toISOString() })
              .eq('sender_address', normalizedAddress)
              .select();
            
            if (!updateError && updateData && updateData.length > 0) {
              updatedCount += updateData.length;
              foundCount++;
            } else {
              // Try with original address if normalized didn't work
              const { data: updateData2, error: updateError2 } = await client
                .from('leaderboard_stats_graph_true')
                .update({ zns_domain: domain, updated_at: new Date().toISOString() })
                .eq('sender_address', address)
                .select();
              
              if (!updateError2 && updateData2 && updateData2.length > 0) {
                updatedCount += updateData2.length;
                foundCount++;
              }
            }
          } catch (error) {
            console.error(`[Update ZNS Graph] Error updating domain for ${address}:`, error);
          }
        }
      }
      
      // Delay between batches to avoid rate limiting
      if (i + batchSize < uniqueAddresses.length) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
      }
    }
    
    console.log(`[Update ZNS Graph] Update completed. Found ${foundCount} domains, updated ${updatedCount} records`);
    
    return c.json({
      success: true,
      message: 'ZNS domains updated successfully for leaderboard_stats_graph_true',
      addresses_checked: uniqueAddresses.length,
      domains_found: foundCount,
      records_updated: updatedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Update ZNS Graph] Failed to update ZNS domains:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      success: false,
      error: 'Failed to update ZNS domains',
      details: errorMessage 
    }, 500);
  }
});

// Check ZNS domain for a specific address
app.get('/leaderboard/check-zns/:address', async (c) => {
  try {
    const address = c.req.param('address');
    const ZNS_API_BASE_URL = 'https://zns.bio/api';
    const ARC_TESTNET_CHAIN_ID = 5042002; // ARC Testnet only
    
    if (!address || !address.startsWith('0x')) {
      return c.json({ error: 'Invalid address format' }, 400);
    }
    
    // Checking ZNS domain
    
    try {
      const url = `${ZNS_API_BASE_URL}/resolveAddress?chain=${ARC_TESTNET_CHAIN_ID}&address=${address}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        return c.json({
          success: false,
          address,
          znsDomain: null,
          message: `ZNS API error: ${response.status}`,
        });
      }
      
      const data = await response.json();
      
      if (data.code === 200 && data.primaryDomain && data.primaryDomain.trim()) {
        return c.json({
          success: true,
          address,
          znsDomain: data.primaryDomain.trim(),
          chainId: ARC_TESTNET_CHAIN_ID,
          userOwnedDomains: data.userOwnedDomains || [],
        });
      }
      
      return c.json({
        success: false,
        address,
        znsDomain: null,
        message: 'No ZNS domain found for this address on ARC Testnet',
      });
    } catch (error) {
      console.error(`Error checking ARC Testnet:`, error);
      return c.json({
        success: false,
        address,
        znsDomain: null,
        message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  } catch (error) {
    console.error('Failed to check ZNS domain:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to check ZNS domain',
      details: errorMessage 
    }, 500);
  }
});

// Update ZNS domains for all addresses in leaderboard
app.post('/leaderboard/update-zns-domains', async (c) => {
  try {
    const client = getSupabaseClient();
    const ZNS_API_BASE_URL = 'https://zns.bio/api';
    const ARC_TESTNET_CHAIN_ID = 5042002; // ARC Testnet only
    
    console.log('Starting ZNS domains update on ARC Testnet...');
    
    // Determine which table(s) to update based on query parameter or environment variable
    const updateTableParam = c.req.query('table');
    const updateTableName = getLeaderboardTableName(updateTableParam);
    const updateBothTables = updateTableName === 'both';
    
    // Get all unique sender addresses from selected table(s)
    let addressesData: any[] = [];
    
    if (updateBothTables) {
      // Get addresses from both tables and merge
      const [statsData, graphData] = await Promise.all([
        client.from('leaderboard_stats').select('sender_address').not('sender_address', 'is', null),
        client.from('leaderboard_stats_graph_true').select('sender_address').not('sender_address', 'is', null)
      ]);
      
      if (statsData.error) throw statsData.error;
      if (graphData.error) throw graphData.error;
      
      // Merge and deduplicate addresses
      const addressSet = new Set<string>();
      [...(statsData.data || []), ...(graphData.data || [])].forEach((row: any) => {
        if (row.sender_address) {
          addressSet.add(row.sender_address.toLowerCase());
        }
      });
      addressesData = Array.from(addressSet).map(addr => ({ sender_address: addr }));
    } else {
      const tableToUse = typeof updateTableName === 'string' ? updateTableName : 'leaderboard_stats';
      const { data, error: fetchError } = await client
        .from(tableToUse)
        .select('sender_address')
        .not('sender_address', 'is', null);
      
      if (fetchError) {
        throw fetchError;
      }
      addressesData = data || [];
    }
    
    // Extract unique addresses and normalize them
    const uniqueAddresses = [...new Set(
      (addressesData || [])
        .map((row: any) => {
          const addr = row.sender_address;
          return addr && addr.startsWith('0x') ? addr.toLowerCase() : null;
        })
        .filter((addr: string | null) => addr !== null) as string[]
    )];
    
    // Found unique addresses to check
    
    let updatedCount = 0;
    let foundCount = 0;
    const batchSize = 5;
    const delayBetweenBatches = 200;
    
    // Helper function to resolve ZNS domain on ARC Testnet
    async function resolveZNSDomain(address: string): Promise<string | null> {
      try {
        const url = `${ZNS_API_BASE_URL}/resolveAddress?chain=${ARC_TESTNET_CHAIN_ID}&address=${address}`;
        const response = await fetch(url);
        
        if (!response.ok) {
          return null;
        }
        
        const data = await response.json();
        
        if (data.code === 200 && data.primaryDomain && data.primaryDomain.trim()) {
          // Found ZNS domain
          return data.primaryDomain.trim();
        }
        
        return null;
      } catch (error) {
        // Error resolving ZNS
        return null;
      }
    }
    
    // Process addresses in batches
    for (let i = 0; i < uniqueAddresses.length; i += batchSize) {
      const batch = uniqueAddresses.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (address: string) => {
        try {
          const domain = await resolveZNSDomain(address);
          return { address, domain };
        } catch (error) {
          // Failed to resolve ZNS
          return { address, domain: null };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      
      // Update database for addresses with domains
      for (const { address, domain } of batchResults) {
        if (domain) {
          try {
            // First, check if address exists in database
            const normalizedAddress = address.toLowerCase();
            const { data: existingRows, error: checkError } = await client
              .from('leaderboard_stats')
              .select('id, sender_address, zns_domain')
              .or(`sender_address.ilike.${normalizedAddress},sender_address.eq.${address}`)
              .limit(5);
            
            if (checkError) {
              console.error(`Error checking address ${address}:`, checkError);
            } else {
              // Found existing rows
              if (existingRows && existingRows.length > 0) {
                // Existing addresses in DB
              }
            }
            
            // Try multiple update strategies
            let updateSucceeded = false;
            let rowsAffected = 0;
            
            // Strategy 1: Try with normalized (lowercase) address
            const { data: updateData1, error: error1 } = await client
              .from('leaderboard_stats')
              .update({ zns_domain: domain, updated_at: new Date().toISOString() })
              .eq('sender_address', normalizedAddress)
              .select();
            
            if (!error1 && updateData1 && updateData1.length > 0) {
              rowsAffected = updateData1.length;
              updateSucceeded = true;
              // Strategy 1 (normalized) succeeded
            } else {
              // Strategy 2: Try with original address
              const { data: updateData2, error: error2 } = await client
                .from('leaderboard_stats')
                .update({ zns_domain: domain, updated_at: new Date().toISOString() })
                .eq('sender_address', address)
                .select();
              
              if (!error2 && updateData2 && updateData2.length > 0) {
                rowsAffected = updateData2.length;
                updateSucceeded = true;
                // Strategy 2 (original) succeeded
              } else {
                // Strategy 3: Try RPC function (case-insensitive)
                const { data: rpcResult, error: rpcError } = await client.rpc('update_zns_domain_case_insensitive', {
                  p_address: address,
                  p_domain: domain
                });
                
                if (!rpcError && rpcResult !== null && rpcResult > 0) {
                  rowsAffected = rpcResult;
                  updateSucceeded = true;
                  // Strategy 3 (RPC) succeeded
                } else {
                  // All update strategies failed
                }
              }
            }
            
            // Verify the update
            if (updateSucceeded) {
              const { data: verifyData, error: verifyError } = await client
                .from('leaderboard_stats')
                .select('id, sender_address, zns_domain')
                .or(`sender_address.eq.${normalizedAddress},sender_address.eq.${address}`)
                .eq('zns_domain', domain);
              
              if (verifyError) {
                // Verification error
              } else {
                const verifiedCount = verifyData?.length || 0;
                // Verification confirmed
                
                if (verifiedCount > 0) {
                  updatedCount += verifiedCount;
                  foundCount++;
                } else {
                  console.warn(`Update reported success but verification found 0 rows. This may indicate a transaction rollback.`);
                }
              }
            }
          } catch (error) {
            // Error updating ZNS domain
          }
        }
      }
      
      // Delay between batches to avoid rate limiting
      if (i + batchSize < uniqueAddresses.length) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
      }
    }
    
    console.log(`ZNS domains update completed. Found ${foundCount} domains, updated ${updatedCount} records`);
    
    return c.json({
      success: true,
      message: 'ZNS domains updated successfully',
      addresses_checked: uniqueAddresses.length,
      domains_found: foundCount,
      records_updated: updatedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Failed to update ZNS domains:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to update ZNS domains',
      details: errorMessage 
    }, 500);
  }
});

// Get gift card details
app.get('/gift-cards/:cardId', async (c) => {
  try {
    const cardId = c.req.param('cardId');
    const card = await kv.get(`gift_card:${cardId}`);
    
    if (!card) {
      return c.json({ error: 'Gift card not found' }, 404);
    }

    // Check if card is expired
    if (new Date() > new Date(card.expires_at)) {
      card.status = 'expired';
      await kv.set(`gift_card:${cardId}`, card);
    }

    // Remove sensitive information
    const publicCard = { ...card };
    delete publicCard.password_hash;
    
    return c.json({ card: publicCard });
  } catch (error) {
    console.log(`Error fetching gift card: ${error}`);
    return c.json({ error: 'Failed to fetch gift card' }, 500);
  }
});

// Redeem gift card
app.post('/gift-cards/:cardId/redeem', async (c) => {
  try {
    // TODO: Add authentication when auth system is ready
    // const { user, error: authError } = await verifyUser(c.req.raw);
    // if (!user) {
    //   return c.json({ error: 'Unauthorized' }, 401);
    // }

    const cardId = c.req.param('cardId');
    const { password, recipientAddress } = await c.req.json();
    
    const card = await kv.get(`gift_card:${cardId}`);
    if (!card) {
      return c.json({ error: 'Gift card not found' }, 404);
    }

    if (card.status !== 'active') {
      return c.json({ error: `Gift card is ${card.status}` }, 400);
    }

    if (new Date() > new Date(card.expires_at)) {
      card.status = 'expired';
      await kv.set(`gift_card:${cardId}`, card);
      return c.json({ error: 'Gift card has expired' }, 400);
    }

    // Check timer
    if (card.has_timer && card.timer_hours > 0) {
      const createdTime = new Date(card.created_at).getTime();
      const now = Date.now();
      const hoursElapsed = (now - createdTime) / (1000 * 60 * 60);
      
      if (hoursElapsed < card.timer_hours) {
        return c.json({ error: 'Gift card is still locked by timer' }, 400);
      }
    }

    // Check password
    if (card.has_password && card.password_hash) {
      if (!password) {
        return c.json({ error: 'Password required' }, 400);
      }
      
      const isValidPassword = await verifyPassword(password, card.password_hash);
      if (!isValidPassword) {
        return c.json({ error: 'Invalid password' }, 400);
      }
    }

    // Mark as redeemed
    card.status = 'redeemed';
    card.redeemed_at = new Date().toISOString();
    card.redeemed_by = 'temp_user'; // TODO: Replace with actual user ID
    card.redeemed_address = recipientAddress;
    
    await kv.set(`gift_card:${cardId}`, card);
    await kv.set(`user_received:temp_user:${cardId}`, { card_id: cardId, redeemed_at: card.redeemed_at });

    // Update analytics
    const userStats = await kv.get(`user_stats:temp_user`) || { 
      total_sent: 0, 
      total_received: 0, 
      cards_sent: 0, 
      cards_received: 0 
    };
    userStats.total_received += parseFloat(card.amount);
    userStats.cards_received += 1;
    await kv.set(`user_stats:temp_user`, userStats);

    // Create transaction record
    const transaction = {
      id: `tx_${Date.now()}`,
      user_id: 'temp_user', // Temporary for testing
      card_id: cardId,
      type: 'redeemed',
      amount: card.amount,
      currency: card.currency,
      counterpart: card.sender_address,
      message: card.message,
      status: 'completed',
      timestamp: new Date().toISOString(),
      tx_hash: card.tx_hash || ''
    };
    
    await kv.set(`transaction:${transaction.id}`, transaction);
    await kv.set(`user_transactions:temp_user:${transaction.id}`, { transaction_id: transaction.id, timestamp: transaction.timestamp });

    return c.json({ 
      card: card,
      secret_message: card.secret_message,
      transaction: transaction 
    });
  } catch (error) {
    console.log(`Error redeeming gift card: ${error}`);
    return c.json({ error: 'Failed to redeem gift card' }, 500);
  }
});

// Get user analytics
app.get('/analytics', async (c) => {
  try {
    // TODO: Add authentication when auth system is ready
    // const { user, error: authError } = await verifyUser(c.req.raw);
    // if (!user) {
    //   return c.json({ error: 'Unauthorized' }, 401);
    // }

    const stats = await kv.get(`user_stats:temp_user`) || { 
      total_sent: 0, 
      total_received: 0, 
      cards_sent: 0, 
      cards_received: 0 
    };

    const analytics = {
      ...stats,
      total_redeemed: stats.total_received,
      average_amount: stats.cards_sent > 0 ? (stats.total_sent / stats.cards_sent).toFixed(2) : '0',
      top_currency: 'USDC' // Could be calculated from actual data
    };

    return c.json({ analytics });
  } catch (error) {
    console.log(`Error fetching analytics: ${error}`);
    return c.json({ error: 'Failed to fetch analytics' }, 500);
  }
});

// Get user transactions
app.get('/transactions', async (c) => {
  try {
    // TODO: Add authentication when auth system is ready
    // const { user, error: authError } = await verifyUser(c.req.raw);
    // if (!user) {
    //   return c.json({ error: 'Unauthorized' }, 401);
    // }

    const transactionRefs = await kv.getByPrefix(`user_transactions:temp_user:`);
    const transactions = [];
    
    for (const ref of transactionRefs) {
      const transaction = await kv.get(`transaction:${ref.transaction_id}`);
      if (transaction) {
        transactions.push(transaction);
      }
    }

    return c.json({ 
      transactions: transactions.sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      ) 
    });
  } catch (error) {
    console.log(`Error fetching transactions: ${error}`);
    return c.json({ error: 'Failed to fetch transactions' }, 500);
  }
});

// Revoke gift card
app.post('/gift-cards/:cardId/revoke', async (c) => {
  try {
    // TODO: Add authentication when auth system is ready
    // const { user, error: authError } = await verifyUser(c.req.raw);
    // if (!user) {
    //   return c.json({ error: 'Unauthorized' }, 401);
    // }

    const cardId = c.req.param('cardId');
    const card = await kv.get(`gift_card:${cardId}`);
    
    if (!card) {
      return c.json({ error: 'Gift card not found' }, 404);
    }

    // Temporarily allow anyone to revoke for testing
    // if (card.sender_id !== user.id) {
    //   return c.json({ error: 'Only the sender can revoke this card' }, 403);
    // }

    if (card.status !== 'active') {
      return c.json({ error: 'Can only revoke active cards' }, 400);
    }

    card.status = 'revoked';
    card.revoked_at = new Date().toISOString();
    
    await kv.set(`gift_card:${cardId}`, card);

    return c.json({ card });
  } catch (error) {
    console.log(`Error revoking gift card: ${error}`);
    return c.json({ error: 'Failed to revoke gift card' }, 500);
  }
});

// Helper functions for password hashing
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  return passwordHash === hash;
}

interface LeaderboardUpdateInput {
  senderAddress?: string | null;
  userIdentifier?: string | null;
  platform?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  amount?: string | number | null;
  currency?: string | null;
  recipientHandle?: string | null;
  chainId?: number | null;
}

function parseNumericValue(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isMissingChainIdColumnError(error: unknown): boolean {
  const message =
    typeof (error as any)?.message === 'string'
      ? String((error as any).message)
      : String(error);
  return message.toLowerCase().includes('chain_id') && message.toLowerCase().includes('does not exist');
}

async function recordLeaderboardSend(update: LeaderboardUpdateInput) {
  try {
    const normalizedAddress = normalizeWalletAddress(update.senderAddress);
    const senderAddress = normalizedAddress || '';
    const baseUserIdentifier = (update.userIdentifier ?? '').trim();
    const userIdentifier = baseUserIdentifier || senderAddress || 'anonymous';
    if (!userIdentifier && !senderAddress) {
      return;
    }

    const client = getSupabaseClient();
    const chainId =
      typeof update.chainId === 'number' && Number.isFinite(update.chainId) && update.chainId > 0
        ? update.chainId
        : 5042002; // ARC default (backward compatible)
    const platform = (update.platform ?? 'generic').toLowerCase();
    const amountNumber = Math.max(0, parseNumericValue(update.amount));
    const currency = (update.currency ?? 'USDC').toUpperCase();
    const now = new Date().toISOString();

    // Helper function to upsert to a table
    const upsertToTable = async (tableName: string) => {
      let existing: any = null;
      try {
        const { data, error: selectError } = await client
          .from(tableName)
          .select('id,cards_sent_total,amount_sent_total,amount_sent_by_currency,display_name,avatar_url,last_recipient')
          .eq('chain_id', chainId)
          .eq('user_identifier', userIdentifier)
          .eq('sender_address', senderAddress)
          .eq('social_platform', platform)
          .maybeSingle();

        if (selectError && selectError.code !== 'PGRST116') {
          throw selectError;
        }
        existing = data ?? null;
      } catch (error) {
        // Backward compatibility: environments where chain_id column isn't deployed yet.
        if (!isMissingChainIdColumnError(error)) {
          throw error;
        }
        console.warn(`[recordLeaderboardSend] chain_id missing on ${tableName}; falling back to legacy keys`);
        const { data, error: selectError } = await client
          .from(tableName)
          .select('id,cards_sent_total,amount_sent_total,amount_sent_by_currency,display_name,avatar_url,last_recipient')
          .eq('user_identifier', userIdentifier)
          .eq('sender_address', senderAddress)
          .eq('social_platform', platform)
          .maybeSingle();
        if (selectError && selectError.code !== 'PGRST116') {
          throw selectError;
        }
        existing = data ?? null;
      }

      const existingAmountTotal = parseNumericValue(existing?.amount_sent_total);
      const existingCurrencyMap =
        existing?.amount_sent_by_currency && typeof existing.amount_sent_by_currency === 'object'
          ? existing.amount_sent_by_currency
          : {};

      const updatedCurrencyMap: Record<string, number> = {};
      for (const [key, value] of Object.entries(existingCurrencyMap as Record<string, number | string>)) {
        updatedCurrencyMap[key] = parseNumericValue(value);
      }
      updatedCurrencyMap[currency] = (updatedCurrencyMap[currency] || 0) + amountNumber;

      try {
        await client
          .from(tableName)
          .upsert({
            id: existing?.id,
            chain_id: chainId,
            user_identifier: userIdentifier,
            sender_address: senderAddress,
            social_platform: platform,
            display_name: update.displayName?.trim() || existing?.display_name || senderAddress || userIdentifier,
            avatar_url: update.avatarUrl || existing?.avatar_url || null,
            last_recipient: update.recipientHandle || existing?.last_recipient || null,
            cards_sent_total: (existing?.cards_sent_total ?? 0) + 1,
            amount_sent_total: existingAmountTotal + amountNumber,
            amount_sent_by_currency: updatedCurrencyMap,
            last_sent_at: now,
            updated_at: now,
          }, { onConflict: 'chain_id,user_identifier,sender_address,social_platform' });
      } catch (error) {
        if (!isMissingChainIdColumnError(error)) {
          throw error;
        }
        // Legacy fallback: no chain_id column/index yet.
        await client
          .from(tableName)
          .upsert({
            id: existing?.id,
            user_identifier: userIdentifier,
            sender_address: senderAddress,
            social_platform: platform,
            display_name: update.displayName?.trim() || existing?.display_name || senderAddress || userIdentifier,
            avatar_url: update.avatarUrl || existing?.avatar_url || null,
            last_recipient: update.recipientHandle || existing?.last_recipient || null,
            cards_sent_total: (existing?.cards_sent_total ?? 0) + 1,
            amount_sent_total: existingAmountTotal + amountNumber,
            amount_sent_by_currency: updatedCurrencyMap,
            last_sent_at: now,
            updated_at: now,
          }, { onConflict: 'user_identifier,sender_address,social_platform' });
      }
    };

    // Determine which tables to write to based on environment variable
    // Default: write to both tables
    const writeTable = Deno.env.get('LEADERBOARD_WRITE_TABLE')?.toLowerCase().trim();
    const writeToBoth = !writeTable || writeTable === 'both' || writeTable === 'all';
    
    if (writeToBoth) {
      // Write to both tables in parallel
      await Promise.all([
        upsertToTable('leaderboard_stats'),
        upsertToTable('leaderboard_stats_graph_true')
      ]);
    } else if (writeTable === 'graph_true' || writeTable === 'graph') {
      await upsertToTable('leaderboard_stats_graph_true');
    } else {
      // Default to leaderboard_stats
      await upsertToTable('leaderboard_stats');
    }
  } catch (error) {
    console.error('Failed to record leaderboard stats:', error);
  }
}

interface LeaderboardRow {
  id: string;
  userIdentifier: string;
  senderAddress: string;
  socialPlatform: string;
  displayName: string | null;
  avatarUrl: string | null;
  lastRecipient: string | null;
  cardsSentTotal: number;
  amountSentTotal: number;
  amountSentByCurrency: Record<string, number>;
  lastSentAt: string | null;
  znsDomain: string | null;
}

interface AggregatedLeaderboardRow extends LeaderboardRow {
  lastSentAtMs: number;
}

function normalizeCurrencyMap(raw: any): Record<string, number> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const currency = typeof key === 'string' ? key.toUpperCase() : String(key);
    normalized[currency] = (normalized[currency] || 0) + parseNumericValue(value);
  }
  return normalized;
}

function mergeCurrencyTotals(
  base: Record<string, number>,
  addition: Record<string, number>
): Record<string, number> {
  const result: Record<string, number> = { ...base };
  for (const [currency, value] of Object.entries(addition || {})) {
    result[currency] = (result[currency] || 0) + parseNumericValue(value);
  }
  return result;
}

function aggregateLeaderboardRows(rows: LeaderboardRow[], limit: number): LeaderboardRow[] {
  const aggregated = new Map<string, AggregatedLeaderboardRow>();

  for (const row of rows) {
    const normalizedAddress = row.senderAddress?.toLowerCase();
    const key = normalizedAddress || row.userIdentifier || row.id;
    if (!key) {
      continue;
    }

    const amountTotal = parseNumericValue(row.amountSentTotal);
    const currencyMap = row.amountSentByCurrency || {};
    const lastSentAtMs = row.lastSentAt ? new Date(row.lastSentAt).getTime() : 0;

    const existing = aggregated.get(key);
    if (!existing) {
      aggregated.set(key, {
        ...row,
        id: `agg:${key}`,
        userIdentifier: normalizedAddress || row.senderAddress || row.userIdentifier || key,
        senderAddress: row.senderAddress || row.userIdentifier || key,
        socialPlatform: 'address',
        displayName: row.displayName || row.senderAddress || row.userIdentifier || key,
        amountSentTotal: amountTotal,
        amountSentByCurrency: { ...currencyMap },
        lastSentAt: row.lastSentAt,
        lastSentAtMs,
        znsDomain: row.znsDomain ?? null,
      });
      continue;
    }

    existing.cardsSentTotal += row.cardsSentTotal;
    existing.amountSentTotal += amountTotal;
    existing.amountSentByCurrency = mergeCurrencyTotals(existing.amountSentByCurrency, currencyMap);

    if (lastSentAtMs > existing.lastSentAtMs) {
      existing.lastSentAt = row.lastSentAt;
      existing.lastRecipient = row.lastRecipient ?? existing.lastRecipient;
      if (row.displayName) {
        existing.displayName = row.displayName;
      }
      if (row.avatarUrl) {
        existing.avatarUrl = row.avatarUrl;
      }
      if (row.znsDomain) {
        existing.znsDomain = row.znsDomain;
      }
      existing.lastSentAtMs = lastSentAtMs;
    } else if (row.znsDomain && !existing.znsDomain) {
      // If current row has ZNS domain but existing doesn't, use it
      existing.znsDomain = row.znsDomain;
    }
  }

  return Array.from(aggregated.values())
    .sort(
      (a, b) =>
        b.cardsSentTotal - a.cardsSentTotal ||
        b.amountSentTotal - a.amountSentTotal
    )
    .slice(0, limit)
    .map(({ lastSentAtMs, ...row }) => row);
}

// Twitter gift card endpoints
// 
// New architecture with Vault contract:
// - Main state (username, tokenId, claimed status) is stored on blockchain in TwitterCardVault
// - KV is used only for additional metadata (message, metadataUri, design, amount, currency)
// - Frontend loads pending cards from Vault contract, then enriches with metadata from KV

// Create Twitter card mapping (saves only metadata to KV)
app.post('/gift-cards/twitter/create', async (c) => {
  try {
    console.log('Received request to create Twitter card mapping');
    const body = await c.req.json().catch((err) => {
      console.error('Failed to parse request body:', err);
      return {};
    });
    
    console.log('Request body:', JSON.stringify(body));
    const chainId = getChainIdFromRequest(c.req.query(), body);
    const { tokenId, username, temporaryOwner, senderAddress, amount, currency, message, metadataUri } = body;
    
    if (!tokenId || !username) {
      console.error('Missing required fields:', { tokenId: !!tokenId, username: !!username });
      return c.json({ 
        error: 'Missing required fields',
        required: ['tokenId', 'username']
      }, 400);
    }
    
    const normalizedUsername = username.toLowerCase().replace('@', '');
    // Creating mapping
    
    // temporaryOwner is now optional (for backward compatibility)
    // In new implementation, Vault contract owns NFT, not temporaryOwner
    const twitterCardMapping = {
      tokenId: tokenId.toString(),
      username: normalizedUsername,
      temporaryOwner: temporaryOwner || '', // Empty string for Vault cards
      senderAddress: senderAddress || temporaryOwner || '',
      amount: amount || '0',
      currency: currency || 'USDC',
      message: message || '',
      metadataUri: metadataUri || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      claimedAt: null,
      realOwner: null
    };
    
    console.log('Saving to KV store...');
    // Save full card metadata
    await kv.set(`twitter_card:${tokenId}`, twitterCardMapping);
    // Save index for searching cards by username (used in GET /gift-cards/twitter/:username)
    await kv.set(`twitter_cards:${normalizedUsername}:${tokenId}`, { tokenId: tokenId.toString(), createdAt: twitterCardMapping.createdAt });
    console.log('Successfully saved Twitter card mapping');

    await recordLeaderboardSend({
      chainId,
      senderAddress: senderAddress || temporaryOwner,
      userIdentifier: senderAddress || temporaryOwner,
      platform: 'twitter',
      displayName: senderAddress || temporaryOwner,
      amount,
      currency,
      recipientHandle: normalizedUsername,
    });
    
    return c.json({ success: true, mapping: twitterCardMapping });
  } catch (error) {
    console.error(`Error creating Twitter card mapping:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error('Error stack:', errorStack);
    return c.json({ 
      error: 'Failed to create Twitter card mapping',
      details: errorMessage 
    }, 500);
  }
});

// Get pending Twitter cards for a username
app.get('/gift-cards/twitter/:username', async (c) => {
  try {
    const username = c.req.param('username').toLowerCase().replace('@', '');
    
    const cardRefs = await kv.getByPrefix(`twitter_cards:${username}:`);
    
    const pendingCards = [];
    for (const ref of cardRefs) {
      const mapping = await kv.get(`twitter_card:${ref.tokenId}`);
      if (mapping && mapping.status === 'pending') {
        pendingCards.push(mapping);
      }
    }
    
    return c.json({ 
      cards: pendingCards.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ) 
    });
  } catch (error) {
    console.log(`Error fetching Twitter cards: ${error}`);
    return c.json({ error: 'Failed to fetch Twitter cards' }, 500);
  }
});

// Get Twitter card mapping by tokenId
app.get('/gift-cards/twitter/by-token/:tokenId', async (c) => {
  try {
    const tokenId = c.req.param('tokenId');
    
    // First, try to get from KV storage
    let mapping = await kv.get(`twitter_card:${tokenId}`);
    
    // If not found in KV, try to get from Supabase database
    if (!mapping) {
      // Twitter card not found in KV, checking Supabase
      const client = getSupabaseClient();
      
      const { data: card, error } = await client
        .from('gift_cards')
        .select('*')
        .eq('token_id', tokenId)
        .eq('recipient_type', 'twitter')
        .single();
      
      if (error || !card) {
        // Twitter card not found in Supabase either
        return c.json({ error: 'Twitter card mapping not found' }, 404);
      }
      
      // Transform Supabase data to TwitterCardMapping format
      const TWITTER_VAULT_ADDRESS = Deno.env.get('VITE_ARC_TWITTER_VAULT_ADDRESS') || '0xF8A0870530bb7CD1D658742A079f85E91dFC8E3C';
      
      mapping = {
        tokenId: card.token_id,
        username: card.recipient_username || '',
        temporaryOwner: TWITTER_VAULT_ADDRESS, // Vault address as temporary owner
        senderAddress: card.sender_address || '',
        amount: card.amount || '0',
        currency: card.currency || 'USDC',
        message: card.message || '',
        metadataUri: '', // Not stored in gift_cards table
        status: card.recipient_address ? 'claimed' : 'pending',
        createdAt: card.created_at ? new Date(card.created_at).toISOString() : new Date().toISOString(),
        claimedAt: card.recipient_address ? (card.updated_at ? new Date(card.updated_at).toISOString() : (card.last_synced_at ? new Date(card.last_synced_at).toISOString() : null)) : null,
        realOwner: card.recipient_address || null
      };
      
      // Successfully loaded Twitter card from Supabase
    }
    
    return c.json({ mapping });
  } catch (error) {
    console.log(`Error fetching Twitter card mapping: ${error}`);
    return c.json({ error: 'Failed to fetch Twitter card mapping' }, 500);
  }
});

// Claim Twitter card
app.post('/gift-cards/twitter/:tokenId/claim', async (c) => {
  try {
    const tokenId = c.req.param('tokenId');
    const body = await c.req.json();
    const { username, walletAddress } = body;
    const chainId = getChainIdFromRequest(c.req.query(), body);

    if (!username || !walletAddress) {
      return c.json({ error: 'Missing username or wallet address' }, 400);
    }
    
    const normalizedUsername = username.toLowerCase().replace('@', '');
    let mapping = await kv.get(`twitter_card:${tokenId}`);
    
    // If not found in KV, try to find in Supabase database
    if (!mapping) {
      console.log(`Twitter card ${tokenId} not found in KV, checking Supabase database...`);
      const client = getSupabaseClient();
      
      const { data: card, error } = await client
        .from('gift_cards')
        .select('*')
        .eq('token_id', tokenId)
        .eq('recipient_type', 'twitter')
        .single();
      
      if (error || !card) {
        // Twitter card not found in Supabase either
        return c.json({ error: 'Twitter card mapping not found' }, 404);
      }
      
      // Verify username matches
      const cardUsername = (card.recipient_username || '').toLowerCase().replace('@', '').trim();
      if (cardUsername !== normalizedUsername) {
        return c.json({ error: 'Username mismatch. This card is not for your Twitter account' }, 403);
      }
      
      // Check if already claimed
      if (card.recipient_address) {
        return c.json({ error: 'Card is already claimed' }, 400);
      }
      
      // Create mapping from Supabase data for KV storage
      const TWITTER_VAULT_ADDRESS = Deno.env.get('VITE_ARC_TWITTER_VAULT_ADDRESS') || '0xF8A0870530bb7CD1D658742A079f85E91dFC8E3C';
      mapping = {
        tokenId: card.token_id,
        username: card.recipient_username || '',
        temporaryOwner: TWITTER_VAULT_ADDRESS,
        senderAddress: card.sender_address || '',
        amount: card.amount || '0',
        currency: card.currency || 'USDC',
        message: card.message || '',
        metadataUri: '',
        status: 'pending',
        createdAt: card.created_at ? new Date(card.created_at).toISOString() : new Date().toISOString(),
        claimedAt: null,
        realOwner: null
      };
      
      // Successfully loaded Twitter card from Supabase for claim
    } else {
      // Found in KV, verify status and username
      if (mapping.status !== 'pending') {
        return c.json({ error: `Card is already ${mapping.status}` }, 400);
      }
      
      const mappingUsername = (mapping.username || '').toLowerCase().replace('@', '').trim();
      
      if (mappingUsername !== normalizedUsername) {
        return c.json({ error: 'Username mismatch. This card is not for your Twitter account' }, 403);
      }
    }
    
    // Update mapping
    mapping.status = 'claimed';
    mapping.realOwner = walletAddress.toLowerCase();
    mapping.claimedAt = new Date().toISOString();
    
    // Save to KV for future requests
    await kv.set(`twitter_card:${tokenId}`, mapping);
    
    // Update Supabase gift_cards table - this is the critical update
    const client = getSupabaseClient();
    const { error: supabaseError } = await client
      .from('gift_cards')
      .update({
        recipient_address: walletAddress.toLowerCase(),
        recipient_type: 'address',
        recipient_username: null, // Clear username since it's now an address-based card
        updated_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
      })
      .eq('token_id', tokenId);
    
    if (supabaseError) {
      console.error('Error updating Supabase gift_cards table:', supabaseError);
      // Still return success since KV was updated, but log the error
      console.warn(`Warning: Supabase update failed for token ${tokenId}, but KV was updated`);
    } else {
      await syncGiftCardsGraphClaimRecipient(client, tokenId, chainId, {
        recipient_address: walletAddress.toLowerCase(),
        recipient_type: 'address',
        recipient_username: null,
        updated_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
      });
    }

    return c.json({
      success: true,
      mapping,
      message: 'Card claimed successfully. Transfer the NFT to complete the process.',
    });
  } catch (error) {
    console.log(`Error claiming Twitter card: ${error}`);
    return c.json({ error: 'Failed to claim Twitter card' }, 500);
  }
});

// Twitch gift card endpoints
// Similar to Twitter, uses TwitchCardVault contract

// Create Twitch card mapping (saves only metadata to KV)
app.post('/gift-cards/twitch/create', async (c) => {
  try {
    console.log('Received request to create Twitch card mapping');
    const body = await c.req.json().catch((err) => {
      console.error('Failed to parse request body:', err);
      return {};
    });
    
    console.log('Request body:', JSON.stringify(body));
    const chainId = getChainIdFromRequest(c.req.query(), body);
    const { tokenId, username, temporaryOwner, senderAddress, amount, currency, message, metadataUri } = body;
    
    if (!tokenId || !username) {
      console.error('Missing required fields:', { tokenId: !!tokenId, username: !!username });
      return c.json({ 
        error: 'Missing required fields',
        required: ['tokenId', 'username']
      }, 400);
    }
    
    const normalizedUsername = username.toLowerCase().trim();
    // Creating Twitch mapping
    
    const twitchCardMapping = {
      tokenId: tokenId.toString(),
      username: normalizedUsername,
      temporaryOwner: temporaryOwner || '',
      senderAddress: senderAddress || temporaryOwner || '',
      amount: amount || '0',
      currency: currency || 'USDC',
      message: message || '',
      metadataUri: metadataUri || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      claimedAt: null,
      realOwner: null
    };
    
    console.log('Saving to KV store...');
    await kv.set(`twitch_card:${tokenId}`, twitchCardMapping);
    await kv.set(`twitch_cards:${normalizedUsername}:${tokenId}`, { tokenId: tokenId.toString(), createdAt: twitchCardMapping.createdAt });
    console.log('Successfully saved Twitch card mapping');

    await recordLeaderboardSend({
      chainId,
      senderAddress: senderAddress || temporaryOwner,
      userIdentifier: senderAddress || temporaryOwner,
      platform: 'twitch',
      displayName: senderAddress || temporaryOwner,
      amount,
      currency,
      recipientHandle: normalizedUsername,
    });
    
    return c.json({ success: true, mapping: twitchCardMapping });
  } catch (error) {
    console.error(`Error creating Twitch card mapping:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to create Twitch card mapping',
      details: errorMessage 
    }, 500);
  }
});

// Get pending Twitch cards for a username
app.get('/gift-cards/twitch/:username', async (c) => {
  try {
    const username = c.req.param('username').toLowerCase().trim();
    
    const cardRefs = await kv.getByPrefix(`twitch_cards:${username}:`);
    
    const pendingCards = [];
    for (const ref of cardRefs) {
      const mapping = await kv.get(`twitch_card:${ref.tokenId}`);
      if (mapping && mapping.status === 'pending') {
        pendingCards.push(mapping);
      }
    }
    
    return c.json({ 
      cards: pendingCards.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ) 
    });
  } catch (error) {
    console.log(`Error fetching Twitch cards: ${error}`);
    return c.json({ error: 'Failed to fetch Twitch cards' }, 500);
  }
});

// Get Twitch card mapping by tokenId
app.get('/gift-cards/twitch/by-token/:tokenId', async (c) => {
  try {
    const tokenId = c.req.param('tokenId');
    
    // First, try to get from KV storage
    let mapping = await kv.get(`twitch_card:${tokenId}`);
    
    // If not found in KV, try to get from Supabase database
    if (!mapping) {
      console.log(`Twitch card ${tokenId} not found in KV, checking Supabase database...`);
      const client = getSupabaseClient();
      
      const { data: card, error } = await client
        .from('gift_cards')
        .select('*')
        .eq('token_id', tokenId)
        .eq('recipient_type', 'twitch')
        .single();
      
      if (error || !card) {
        console.log(`Twitch card ${tokenId} not found in Supabase either`);
        return c.json({ error: 'Twitch card mapping not found' }, 404);
      }
      
      // Transform Supabase data to TwitchCardMapping format
      const TWITCH_VAULT_ADDRESS = Deno.env.get('VITE_ARC_TWITCH_VAULT_ADDRESS') || '0xA27E6Cef4e9d794EE0356461fe65437Bb5f7cbE3';
      
      mapping = {
        tokenId: card.token_id,
        username: card.recipient_username || '',
        temporaryOwner: TWITCH_VAULT_ADDRESS,
        senderAddress: card.sender_address || '',
        amount: card.amount || '0',
        currency: card.currency || 'USDC',
        message: card.message || '',
        metadataUri: '',
        status: card.recipient_address ? 'claimed' : 'pending',
        createdAt: card.created_at ? new Date(card.created_at).toISOString() : new Date().toISOString(),
        claimedAt: card.recipient_address ? (card.updated_at ? new Date(card.updated_at).toISOString() : null) : null,
        realOwner: card.recipient_address || null
      };
      
      console.log(`Successfully loaded Twitch card ${tokenId} from Supabase`);
    }
    
    return c.json({ mapping });
  } catch (error) {
    console.log(`Error fetching Twitch card mapping: ${error}`);
    return c.json({ error: 'Failed to fetch Twitch card mapping' }, 500);
  }
});

// Claim Twitch card
app.post('/gift-cards/twitch/:tokenId/claim', async (c) => {
  try {
    const tokenId = c.req.param('tokenId');
    const body = await c.req.json();
    const chainId = getChainIdFromRequest(c.req.query(), body);
    const {
      username,
      walletAddress, // Optional - if MetaMask is available
      privyUserId, // For creating a Developer wallet
      useDeveloperWallet, // Flag to choose wallet type
      socialUserId, // Twitch ID for verification
    } = body;

    if (!username) {
      return c.json({ error: 'Missing username' }, 400);
    }
    
    const normalizedUsername = username.toLowerCase().trim();
    let mapping = await kv.get(`twitch_card:${tokenId}`);
    
    // If not found in KV, try to find in Supabase database
    if (!mapping) {
      console.log(`Twitch card ${tokenId} not found in KV, checking Supabase database...`);
      const client = getSupabaseClient();
      
      const { data: card, error } = await client
        .from('gift_cards')
        .select('*')
        .eq('token_id', tokenId)
        .eq('recipient_type', 'twitch')
        .single();
      
      if (error || !card) {
        console.log(`Twitch card ${tokenId} not found in Supabase either`);
        return c.json({ error: 'Twitch card mapping not found' }, 404);
      }
      
      // Verify username matches
      const cardUsername = (card.recipient_username || '').toLowerCase().trim();
      if (cardUsername !== normalizedUsername) {
        return c.json({ error: 'Username mismatch. This card is not for your Twitch account' }, 403);
      }
      
      // Check if already claimed
      if (card.recipient_address) {
        return c.json({ error: 'Card is already claimed' }, 400);
      }
      
      // Create mapping from Supabase data for KV storage
      const TWITCH_VAULT_ADDRESS = Deno.env.get('VITE_ARC_TWITCH_VAULT_ADDRESS') || '0xA27E6Cef4e9d794EE0356461fe65437Bb5f7cbE3';
      mapping = {
        tokenId: card.token_id,
        username: card.recipient_username || '',
        temporaryOwner: TWITCH_VAULT_ADDRESS,
        senderAddress: card.sender_address || '',
        amount: card.amount || '0',
        currency: card.currency || 'USDC',
        message: card.message || '',
        metadataUri: '',
        status: 'pending',
        createdAt: card.created_at ? new Date(card.created_at).toISOString() : new Date().toISOString(),
        claimedAt: null,
        realOwner: null
      };
      
      // Successfully loaded Twitch card from Supabase for claim
    } else {
      // Found in KV, verify status and username
      if (mapping.status !== 'pending') {
        return c.json({ error: `Card is already ${mapping.status}` }, 400);
      }
      
      const mappingUsername = (mapping.username || '').toLowerCase().trim();
      
      if (mappingUsername !== normalizedUsername) {
        return c.json({ error: 'Username mismatch. This card is not for your Twitch account' }, 403);
      }
    }

    let targetWalletAddress: string;
    let useCircleAPI = false;
    let devWallet: any = null;

    //Def address for claim
    if (useDeveloperWallet || !walletAddress) {
      // Use Developer wallet
      const client = getSupabaseClient();
      
      // Find or create Developer wallet
      let { data: existingWallet } = await client
        .from('developer_wallets')
        .select('*')
        .eq('social_platform', 'twitch')
        .eq('social_user_id', socialUserId || '')
        .eq('blockchain', 'ARC-TESTNET')
        .single();

      if (!existingWallet && privyUserId && socialUserId) {
        // Create Developer wallet automatically
        const SUPABASE_FUNCTION_URL = Deno.env.get('SUPABASE_FUNCTION_URL') || 
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/server`;
        
        const createResponse = await fetch(`${SUPABASE_FUNCTION_URL}/wallets/create-for-social`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: 'twitch',
            socialUserId: socialUserId,
            socialUsername: normalizedUsername,
            privyUserId: privyUserId,
            blockchain: 'ARC-TESTNET'
          })
        });

        if (!createResponse.ok) {
          const errorText = await createResponse.text();
          throw new Error(`Failed to create Developer wallet: ${errorText}`);
        }

        const createResult = await createResponse.json();
        existingWallet = createResult.wallet;
      }

      if (!existingWallet) {
        return c.json({ 
          error: 'Developer wallet not found and could not be created',
          message: 'Please provide walletAddress or ensure privyUserId and socialUserId are provided'
        }, 400);
      }

      devWallet = existingWallet;
      targetWalletAddress = existingWallet.wallet_address;
      useCircleAPI = true;
    } else {
      // Use  MetaMask wallet
      targetWalletAddress = walletAddress;
      useCircleAPI = false;
    }

    // Claim the card
    if (useCircleAPI && devWallet) {
      // use Circle API to send transaction
      const TWITCH_VAULT_CONTRACT_ADDRESS = Deno.env.get('VITE_ARC_TWITCH_VAULT_ADDRESS') || 
        '0xA27E6Cef4e9d794EE0356461fe65437Bb5f7cbE3';
      
      const SUPABASE_FUNCTION_URL = Deno.env.get('SUPABASE_FUNCTION_URL') || 
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/server`;
      
      const txResponse = await fetch(`${SUPABASE_FUNCTION_URL}/wallets/send-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletId: devWallet.circle_wallet_id,
          walletAddress: targetWalletAddress,
          contractAddress: TWITCH_VAULT_CONTRACT_ADDRESS,
          functionName: 'claimCard',
          args: [tokenId, normalizedUsername, targetWalletAddress],
          blockchain: 'ARC-TESTNET',
          privyUserId: privyUserId,
          socialPlatform: 'twitch',
          socialUserId: socialUserId
        })
      });

      const txResult = await txResponse.json();
      if (!txResult.success || !txResult.txHash) {
        throw new Error(txResult.error || 'Failed to send transaction');
      }

      // refresh mapping data
      mapping.status = 'claimed';
      mapping.realOwner = targetWalletAddress;
      mapping.claimedAt = new Date().toISOString();
      await kv.set(`twitch_card:${tokenId}`, mapping);

      // Update Supabase gift_cards table
      try {
        const client = getSupabaseClient();
        const { error: supabaseError } = await client
          .from('gift_cards')
          .update({
            recipient_address: targetWalletAddress.toLowerCase(),
            recipient_type: 'address',
            recipient_username: null, // Clear username since it's now an address-based card
            updated_at: new Date().toISOString(),
            last_synced_at: new Date().toISOString(),
          })
          .eq('token_id', tokenId);
        
        if (supabaseError) {
          console.error('Error updating Supabase gift_cards table:', supabaseError);
        } else {
          await syncGiftCardsGraphClaimRecipient(client, tokenId, chainId, {
            recipient_address: targetWalletAddress.toLowerCase(),
            recipient_type: 'address',
            recipient_username: null,
            updated_at: new Date().toISOString(),
            last_synced_at: new Date().toISOString(),
          });
        }
      } catch (supabaseUpdateError) {
        console.error('Exception updating Supabase gift_cards table:', supabaseUpdateError);
      }

      return c.json({
        success: true,
        txHash: txResult.txHash,
        walletAddress: targetWalletAddress,
        mapping,
        message: 'Card claimed successfully via Developer wallet'
      });
    } else {
      // Current logic for MetaMask (only update mapping; the transaction is executed on the frontend)
      mapping.status = 'claimed';
      mapping.realOwner = targetWalletAddress;
      mapping.claimedAt = new Date().toISOString();
      
      await kv.set(`twitch_card:${tokenId}`, mapping);
      
      // Update Supabase gift_cards table
      try {
        const client = getSupabaseClient();
        const { error: supabaseError } = await client
          .from('gift_cards')
          .update({
            recipient_address: targetWalletAddress.toLowerCase(),
            recipient_type: 'address',
            recipient_username: null, // Clear username since it's now an address-based card
            updated_at: new Date().toISOString(),
            last_synced_at: new Date().toISOString(),
          })
          .eq('token_id', tokenId);
        
        if (supabaseError) {
          console.error('Error updating Supabase gift_cards table:', supabaseError);
        } else {
          await syncGiftCardsGraphClaimRecipient(client, tokenId, chainId, {
            recipient_address: targetWalletAddress.toLowerCase(),
            recipient_type: 'address',
            recipient_username: null,
            updated_at: new Date().toISOString(),
            last_synced_at: new Date().toISOString(),
          });
        }
      } catch (supabaseUpdateError) {
        console.error('Exception updating Supabase gift_cards table:', supabaseUpdateError);
      }

      return c.json({
        success: true,
        mapping,
        message: 'Card claimed successfully. Transfer the NFT to complete the process.'
      });
    }
  } catch (error) {
    console.log(`Error claiming Twitch card: ${error}`);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to claim Twitch card',
      details: errorMessage
    }, 500);
  }
});

// Telegram gift card endpoints - similar structure to Twitter/Twitch
app.post('/gift-cards/telegram/create', async (c) => {
  try {
    console.log('Received request to create Telegram card mapping');
    const body = await c.req.json().catch((err) => {
      console.error('Failed to parse request body:', err);
      return {};
    });

    const chainId = getChainIdFromRequest(c.req.query(), body);
    const { tokenId, username, temporaryOwner, senderAddress, amount, currency, message, metadataUri } = body;

    if (!tokenId || !username) {
      console.error('Missing required fields for Telegram mapping');
      return c.json({
        error: 'Missing required fields',
        required: ['tokenId', 'username']
      }, 400);
    }

    const normalizedUsername = username.toLowerCase().replace(/^@/, '').trim();
    // Creating Telegram mapping

    const telegramCardMapping = {
      tokenId: tokenId.toString(),
      username: normalizedUsername,
      temporaryOwner: temporaryOwner || '',
      senderAddress: senderAddress || temporaryOwner || '',
      amount: amount || '0',
      currency: currency || 'USDC',
      message: message || '',
      metadataUri: metadataUri || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      claimedAt: null,
      realOwner: null
    };

    await kv.set(`telegram_card:${tokenId}`, telegramCardMapping);
    await kv.set(`telegram_cards:${normalizedUsername}:${tokenId}`, { tokenId: tokenId.toString(), createdAt: telegramCardMapping.createdAt });

    await recordLeaderboardSend({
      chainId,
      senderAddress: senderAddress || temporaryOwner,
      userIdentifier: senderAddress || temporaryOwner,
      platform: 'telegram',
      displayName: senderAddress || temporaryOwner,
      amount,
      currency,
      recipientHandle: normalizedUsername,
    });

    return c.json({ success: true, mapping: telegramCardMapping });
  } catch (error) {
    console.error(`Error creating Telegram card mapping:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      error: 'Failed to create Telegram card mapping',
      details: errorMessage
    }, 500);
  }
});

app.get('/gift-cards/telegram/:username', async (c) => {
  try {
    const username = c.req.param('username').toLowerCase().replace(/^@/, '').trim();
    const cardRefs = await kv.getByPrefix(`telegram_cards:${username}:`);

    const pendingCards = [];
    for (const ref of cardRefs) {
      const mapping = await kv.get(`telegram_card:${ref.tokenId}`);
      if (mapping && mapping.status === 'pending') {
        pendingCards.push(mapping);
      }
    }

    pendingCards.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ cards: pendingCards });
  } catch (error) {
    console.log(`Error fetching Telegram cards: ${error}`);
    return c.json({ error: 'Failed to fetch Telegram cards' }, 500);
  }
});

app.get('/gift-cards/telegram/by-token/:tokenId', async (c) => {
  try {
    const tokenId = c.req.param('tokenId');
    
    // First, try to get from KV storage
    let mapping = await kv.get(`telegram_card:${tokenId}`);
    
    // If not found in KV, try to get from Supabase database
    if (!mapping) {
      console.log(`Telegram card ${tokenId} not found in KV, checking Supabase database...`);
      const client = getSupabaseClient();
      
      const { data: card, error } = await client
        .from('gift_cards')
        .select('*')
        .eq('token_id', tokenId)
        .eq('recipient_type', 'telegram')
        .single();
      
      if (error || !card) {
        console.log(`Telegram card ${tokenId} not found in Supabase either`);
        return c.json({ error: 'Telegram card mapping not found' }, 404);
      }
      
      // Transform Supabase data to TelegramCardMapping format
      const TELEGRAM_VAULT_ADDRESS = Deno.env.get('VITE_ARC_TELEGRAM_VAULT_ADDRESS') || '0x619A49213860A0448736880c4f456bCDfB96D938';
      
      mapping = {
        tokenId: card.token_id,
        username: card.recipient_username || '',
        temporaryOwner: TELEGRAM_VAULT_ADDRESS,
        senderAddress: card.sender_address || '',
        amount: card.amount || '0',
        currency: card.currency || 'USDC',
        message: card.message || '',
        metadataUri: '',
        status: card.recipient_address ? 'claimed' : 'pending',
        createdAt: card.created_at ? new Date(card.created_at).toISOString() : new Date().toISOString(),
        claimedAt: card.recipient_address ? (card.updated_at ? new Date(card.updated_at).toISOString() : null) : null,
        realOwner: card.recipient_address || null
      };
      
      console.log(`Successfully loaded Telegram card ${tokenId} from Supabase`);
    }
    
    return c.json({ mapping });
  } catch (error) {
    console.log(`Error fetching Telegram card mapping: ${error}`);
    return c.json({ error: 'Failed to fetch Telegram card mapping' }, 500);
  }
});

app.post('/gift-cards/telegram/:tokenId/claim', async (c) => {
  try {
    const tokenId = c.req.param('tokenId');
    const body = await c.req.json();
    const { username, walletAddress } = body;
    const chainId = getChainIdFromRequest(c.req.query(), body);

    if (!username || !walletAddress) {
      return c.json({ error: 'Missing username or wallet address' }, 400);
    }

    const normalizedUsername = username.toLowerCase().replace(/^@/, '').trim();
    let mapping = await kv.get(`telegram_card:${tokenId}`);

    // If not found in KV, try to find in Supabase database
    if (!mapping) {
      console.log(`Telegram card ${tokenId} not found in KV, checking Supabase database...`);
      const client = getSupabaseClient();
      
      const { data: card, error } = await client
        .from('gift_cards')
        .select('*')
        .eq('token_id', tokenId)
        .eq('recipient_type', 'telegram')
        .single();
      
      if (error || !card) {
        console.log(`Telegram card ${tokenId} not found in Supabase either`);
        return c.json({ error: 'Telegram card mapping not found' }, 404);
      }
      
      // Verify username matches
      const cardUsername = (card.recipient_username || '').toLowerCase().replace(/^@/, '').trim();
      if (cardUsername !== normalizedUsername) {
        return c.json({ error: 'Username mismatch. This card is not for your Telegram account' }, 403);
      }
      
      // Check if already claimed
      if (card.recipient_address) {
        return c.json({ error: 'Card is already claimed' }, 400);
      }
      
      // Create mapping from Supabase data for KV storage
      const TELEGRAM_VAULT_ADDRESS = Deno.env.get('VITE_ARC_TELEGRAM_VAULT_ADDRESS') || '0x619A49213860A0448736880c4f456bCDfB96D938';
      mapping = {
        tokenId: card.token_id,
        username: card.recipient_username || '',
        temporaryOwner: TELEGRAM_VAULT_ADDRESS,
        senderAddress: card.sender_address || '',
        amount: card.amount || '0',
        currency: card.currency || 'USDC',
        message: card.message || '',
        metadataUri: '',
        status: 'pending',
        createdAt: card.created_at ? new Date(card.created_at).toISOString() : new Date().toISOString(),
        claimedAt: null,
        realOwner: null
      };
      
      // Successfully loaded Telegram card from Supabase for claim
    } else {
      // Found in KV, verify status and username
      if (mapping.status !== 'pending') {
        return c.json({ error: `Card is already ${mapping.status}` }, 400);
      }
      
      const mappingUsername = (mapping.username || '').toLowerCase().replace(/^@/, '').trim();
      
      if (mappingUsername !== normalizedUsername) {
        return c.json({ error: 'Username mismatch. This card is not for your Telegram account' }, 403);
      }
    }

    mapping.status = 'claimed';
    mapping.realOwner = walletAddress.toLowerCase();
    mapping.claimedAt = new Date().toISOString();

    await kv.set(`telegram_card:${tokenId}`, mapping);

    // Update Supabase gift_cards table - this is the critical update
    try {
      const client = getSupabaseClient();
      const { error: supabaseError } = await client
        .from('gift_cards')
        .update({
          recipient_address: walletAddress.toLowerCase(),
          recipient_type: 'address',
          recipient_username: null, // Clear username since it's now an address-based card
          updated_at: new Date().toISOString(),
          last_synced_at: new Date().toISOString(),
        })
        .eq('token_id', tokenId);
        
      if (supabaseError) {
        console.error('Error updating Supabase gift_cards table:', supabaseError);
        // Don't fail the request if Supabase update fails, but log it
      } else {
        await syncGiftCardsGraphClaimRecipient(client, tokenId, chainId, {
          recipient_address: walletAddress.toLowerCase(),
          recipient_type: 'address',
          recipient_username: null,
          updated_at: new Date().toISOString(),
          last_synced_at: new Date().toISOString(),
        });
      }
    } catch (supabaseUpdateError) {
      console.error('Exception updating Supabase gift_cards table:', supabaseUpdateError);
      // Don't fail the request if Supabase update fails
    }

    return c.json({
      success: true,
      mapping,
      message: 'Card claimed successfully. Transfer the NFT to complete the process.'
    });
  } catch (error) {
    console.log(`Error claiming Telegram card: ${error}`);
    return c.json({ error: 'Failed to claim Telegram card' }, 500);
  }
});

// Get TikTok card mapping by tokenId
app.get('/gift-cards/tiktok/by-token/:tokenId', async (c) => {
  try {
    const tokenId = c.req.param('tokenId');
    
    // First, try to get from KV storage
    let mapping = await kv.get(`tiktok_card:${tokenId}`);
    
    // If not found in KV, try to get from Supabase database
    if (!mapping) {
      console.log(`TikTok card ${tokenId} not found in KV, checking Supabase database...`);
      const client = getSupabaseClient();
      
      const { data: card, error } = await client
        .from('gift_cards')
        .select('*')
        .eq('token_id', tokenId)
        .eq('recipient_type', 'tiktok')
        .single();
      
      if (error || !card) {
        console.log(`TikTok card ${tokenId} not found in Supabase either`);
        return c.json({ error: 'TikTok card mapping not found' }, 404);
      }
      
      // Transform Supabase data to TikTokCardMapping format
      const TIKTOK_VAULT_ADDRESS = Deno.env.get('VITE_ARC_TIKTOK_VAULT_ADDRESS') || '0xA4A44F97B8778B4Da8b9562d56A94BfCc0fB9893';
      
      mapping = {
        tokenId: card.token_id,
        username: card.recipient_username || '',
        temporaryOwner: TIKTOK_VAULT_ADDRESS,
        senderAddress: card.sender_address || '',
        amount: card.amount || '0',
        currency: card.currency || 'USDC',
        message: card.message || '',
        metadataUri: '',
        status: card.recipient_address ? 'claimed' : 'pending',
        createdAt: card.created_at ? new Date(card.created_at).toISOString() : new Date().toISOString(),
        claimedAt: card.recipient_address ? (card.updated_at ? new Date(card.updated_at).toISOString() : null) : null,
        realOwner: card.recipient_address || null
      };
      
      console.log(`Successfully loaded TikTok card ${tokenId} from Supabase`);
    }
    
    return c.json({ mapping });
  } catch (error) {
    console.log(`Error fetching TikTok card mapping: ${error}`);
    return c.json({ error: 'Failed to fetch TikTok card mapping' }, 500);
  }
});

// TikTok gift card claim endpoint
app.post('/gift-cards/tiktok/:tokenId/claim', async (c) => {
  try {
    const tokenId = c.req.param('tokenId');
    const body = await c.req.json();
    const { username, walletAddress } = body;
    const chainId = getChainIdFromRequest(c.req.query(), body);

    if (!username || !walletAddress) {
      return c.json({ error: 'Missing username or wallet address' }, 400);
    }
    
    const normalizedUsername = username.toLowerCase().replace(/^@/, '').trim();
    let mapping = await kv.get(`tiktok_card:${tokenId}`);
    
    // If not found in KV, try to find in Supabase database
    if (!mapping) {
      console.log(`TikTok card ${tokenId} not found in KV, checking Supabase database...`);
      const client = getSupabaseClient();
      
      const { data: card, error } = await client
        .from('gift_cards')
        .select('*')
        .eq('token_id', tokenId)
        .eq('recipient_type', 'tiktok')
        .single();
      
      if (error || !card) {
        console.log(`TikTok card ${tokenId} not found in Supabase either`);
        return c.json({ error: 'TikTok card mapping not found' }, 404);
      }
      
      // Verify username matches
      const cardUsername = (card.recipient_username || '').toLowerCase().replace(/^@/, '').trim();
      if (cardUsername !== normalizedUsername) {
        return c.json({ error: 'Username mismatch. This card is not for your TikTok account' }, 403);
      }
      
      // Check if already claimed
      if (card.recipient_address) {
        return c.json({ error: 'Card is already claimed' }, 400);
      }
      
      // Create mapping from Supabase data for KV storage
      const TIKTOK_VAULT_ADDRESS = Deno.env.get('VITE_ARC_TIKTOK_VAULT_ADDRESS') || '0xA4A44F97B8778B4Da8b9562d56A94BfCc0fB9893';
      mapping = {
        tokenId: card.token_id,
        username: card.recipient_username || '',
        temporaryOwner: TIKTOK_VAULT_ADDRESS,
        senderAddress: card.sender_address || '',
        amount: card.amount || '0',
        currency: card.currency || 'USDC',
        message: card.message || '',
        metadataUri: '',
        status: 'pending',
        createdAt: card.created_at ? new Date(card.created_at).toISOString() : new Date().toISOString(),
        claimedAt: null,
        realOwner: null
      };
      
      // Successfully loaded TikTok card from Supabase for claim
    } else {
      // Found in KV, verify status and username
      if (mapping.status !== 'pending') {
        return c.json({ error: `Card is already ${mapping.status}` }, 400);
      }
      
      const mappingUsername = (mapping.username || '').toLowerCase().replace(/^@/, '').trim();
      
      if (mappingUsername !== normalizedUsername) {
        return c.json({ error: 'Username mismatch. This card is not for your TikTok account' }, 403);
      }
    }
    
    mapping.status = 'claimed';
    mapping.realOwner = walletAddress.toLowerCase();
    mapping.claimedAt = new Date().toISOString();
    
    await kv.set(`tiktok_card:${tokenId}`, mapping);
    
    // Update Supabase gift_cards table - this is the critical update
    try {
      const client = getSupabaseClient();
      const { error: supabaseError } = await client
        .from('gift_cards')
        .update({
          recipient_address: walletAddress.toLowerCase(),
          recipient_type: 'address',
          recipient_username: null, // Clear username since it's now an address-based card
          updated_at: new Date().toISOString(),
          last_synced_at: new Date().toISOString(),
        })
        .eq('token_id', tokenId);
      
      if (supabaseError) {
        console.error('Error updating Supabase gift_cards table:', supabaseError);
      } else {
        await syncGiftCardsGraphClaimRecipient(client, tokenId, chainId, {
          recipient_address: walletAddress.toLowerCase(),
          recipient_type: 'address',
          recipient_username: null,
          updated_at: new Date().toISOString(),
          last_synced_at: new Date().toISOString(),
        });
      }
    } catch (supabaseUpdateError) {
      console.error('Exception updating Supabase gift_cards table:', supabaseUpdateError);
    }

    return c.json({
      success: true,
      mapping,
      message: 'Card claimed successfully. Transfer the NFT to complete the process.'
    });
  } catch (error) {
    console.log(`Error claiming TikTok card: ${error}`);
    return c.json({ error: 'Failed to claim TikTok card' }, 500);
  }
});

// Get Instagram card mapping by tokenId
app.get('/gift-cards/instagram/by-token/:tokenId', async (c) => {
  try {
    const tokenId = c.req.param('tokenId');
    
    // First, try to get from KV storage
    let mapping = await kv.get(`instagram_card:${tokenId}`);
    
    // If not found in KV, try to get from Supabase database
    if (!mapping) {
      console.log(`Instagram card ${tokenId} not found in KV, checking Supabase database...`);
      const client = getSupabaseClient();
      
      const { data: card, error } = await client
        .from('gift_cards')
        .select('*')
        .eq('token_id', tokenId)
        .eq('recipient_type', 'instagram')
        .single();
      
      if (error || !card) {
        console.log(`Instagram card ${tokenId} not found in Supabase either`);
        return c.json({ error: 'Instagram card mapping not found' }, 404);
      }
      
      // Transform Supabase data to InstagramCardMapping format
      const INSTAGRAM_VAULT_ADDRESS = Deno.env.get('VITE_ARC_INSTAGRAM_VAULT_ADDRESS') || '0x3332dEf130Ea17C69B9dFe8F06be1162526873df';
      
      mapping = {
        tokenId: card.token_id,
        username: card.recipient_username || '',
        temporaryOwner: INSTAGRAM_VAULT_ADDRESS,
        senderAddress: card.sender_address || '',
        amount: card.amount || '0',
        currency: card.currency || 'USDC',
        message: card.message || '',
        metadataUri: '',
        status: card.recipient_address ? 'claimed' : 'pending',
        createdAt: card.created_at ? new Date(card.created_at).toISOString() : new Date().toISOString(),
        claimedAt: card.recipient_address ? (card.updated_at ? new Date(card.updated_at).toISOString() : null) : null,
        realOwner: card.recipient_address || null
      };
      
      console.log(`Successfully loaded Instagram card ${tokenId} from Supabase`);
    }
    
    return c.json({ mapping });
  } catch (error) {
    console.log(`Error fetching Instagram card mapping: ${error}`);
    return c.json({ error: 'Failed to fetch Instagram card mapping' }, 500);
  }
});

// Instagram gift card claim endpoint
app.post('/gift-cards/instagram/:tokenId/claim', async (c) => {
  try {
    const tokenId = c.req.param('tokenId');
    const body = await c.req.json();
    const { username, walletAddress } = body;
    const chainId = getChainIdFromRequest(c.req.query(), body);

    if (!username || !walletAddress) {
      return c.json({ error: 'Missing username or wallet address' }, 400);
    }
    
    const normalizedUsername = username.toLowerCase().replace(/^@/, '').trim();
    let mapping = await kv.get(`instagram_card:${tokenId}`);
    
    // If not found in KV, try to find in Supabase database
    if (!mapping) {
      console.log(`Instagram card ${tokenId} not found in KV, checking Supabase database...`);
      const client = getSupabaseClient();
      
      const { data: card, error } = await client
        .from('gift_cards')
        .select('*')
        .eq('token_id', tokenId)
        .eq('recipient_type', 'instagram')
        .single();
      
      if (error || !card) {
        console.log(`Instagram card ${tokenId} not found in Supabase either`);
        return c.json({ error: 'Instagram card mapping not found' }, 404);
      }
      
      // Verify username matches
      const cardUsername = (card.recipient_username || '').toLowerCase().replace(/^@/, '').trim();
      if (cardUsername !== normalizedUsername) {
        return c.json({ error: 'Username mismatch. This card is not for your Instagram account' }, 403);
      }
      
      // Check if already claimed
      if (card.recipient_address) {
        return c.json({ error: 'Card is already claimed' }, 400);
      }
      
      // Create mapping from Supabase data for KV storage
      const INSTAGRAM_VAULT_ADDRESS = Deno.env.get('VITE_ARC_INSTAGRAM_VAULT_ADDRESS') || '0x3332dEf130Ea17C69B9dFe8F06be1162526873df';
      mapping = {
        tokenId: card.token_id,
        username: card.recipient_username || '',
        temporaryOwner: INSTAGRAM_VAULT_ADDRESS,
        senderAddress: card.sender_address || '',
        amount: card.amount || '0',
        currency: card.currency || 'USDC',
        message: card.message || '',
        metadataUri: '',
        status: 'pending',
        createdAt: card.created_at ? new Date(card.created_at).toISOString() : new Date().toISOString(),
        claimedAt: null,
        realOwner: null
      };
      
      // Successfully loaded Instagram card from Supabase for claim
    } else {
      // Found in KV, verify status and username
      if (mapping.status !== 'pending') {
        return c.json({ error: `Card is already ${mapping.status}` }, 400);
      }
      
      const mappingUsername = (mapping.username || '').toLowerCase().replace(/^@/, '').trim();
      
      if (mappingUsername !== normalizedUsername) {
        return c.json({ error: 'Username mismatch. This card is not for your Instagram account' }, 403);
      }
    }
    
    mapping.status = 'claimed';
    mapping.realOwner = walletAddress.toLowerCase();
    mapping.claimedAt = new Date().toISOString();
    
    await kv.set(`instagram_card:${tokenId}`, mapping);
    
    // Update Supabase gift_cards table - this is the critical update
    try {
      const client = getSupabaseClient();
      const { error: supabaseError } = await client
        .from('gift_cards')
        .update({
          recipient_address: walletAddress.toLowerCase(),
          recipient_type: 'address',
          recipient_username: null, // Clear username since it's now an address-based card
          updated_at: new Date().toISOString(),
          last_synced_at: new Date().toISOString(),
        })
        .eq('token_id', tokenId);
      
      if (supabaseError) {
        console.error('Error updating Supabase gift_cards table:', supabaseError);
      } else {
        await syncGiftCardsGraphClaimRecipient(client, tokenId, chainId, {
          recipient_address: walletAddress.toLowerCase(),
          recipient_type: 'address',
          recipient_username: null,
          updated_at: new Date().toISOString(),
          last_synced_at: new Date().toISOString(),
        });
      }
    } catch (supabaseUpdateError) {
      console.error('Exception updating Supabase gift_cards table:', supabaseUpdateError);
    }

    return c.json({
      success: true,
      mapping,
      message: 'Card claimed successfully. Transfer the NFT to complete the process.'
    });
  } catch (error) {
    console.log(`Error claiming Instagram card: ${error}`);
    return c.json({ error: 'Failed to claim Instagram card' }, 500);
  }
});

// Get Twitch access token from Privy
// Get saved OAuth token from database
app.post('/contacts/get-saved-token', async (c) => {
  try {
    const { privyUserId, platform = 'twitch' } = await c.req.json();
    
    if (!privyUserId) {
      return c.json({ error: 'Missing required field: privyUserId' }, 400);
    }

    const client = getSupabaseClient();
    
    // Get saved token from database
    const { data: tokenData, error } = await client
      .from('oauth_tokens')
      .select('*')
      .eq('user_id', privyUserId)
      .eq('platform', platform)
      .single();

    if (error || !tokenData) {
      return c.json({
        success: false,
        error: 'No saved token found',
        needsAuth: true
      });
    }

    // Check if token is expired
    if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
      // Token expired, delete it
      await client
        .from('oauth_tokens')
        .delete()
        .eq('user_id', privyUserId)
        .eq('platform', platform);

      return c.json({
        success: false,
        error: 'Token expired',
        needsAuth: true
      });
    }

    // Validate token by making a test request to Twitch API
    if (platform === 'twitch') {
      const twitchClientId = Deno.env.get('VITE_TWITCH_CLIENT_ID');
      if (!twitchClientId) {
        return c.json({
          success: true,
          accessToken: tokenData.access_token,
          twitchUserId: null
        });
      }

      try {
        const validateResponse = await fetch('https://id.twitch.tv/oauth2/validate', {
          method: 'GET',
          headers: {
            'Authorization': `OAuth ${tokenData.access_token}`
          }
        });

        if (!validateResponse.ok) {
          // Token is invalid, delete it
          await client
            .from('oauth_tokens')
            .delete()
            .eq('user_id', privyUserId)
            .eq('platform', platform);

          return c.json({
            success: false,
            error: 'Token validation failed',
            needsAuth: true
          });
        }

        const validateData = await validateResponse.json();
        return c.json({
          success: true,
          accessToken: tokenData.access_token,
          twitchUserId: validateData.user_id || null
        });
      } catch (validateError) {
        console.error('Error validating token:', validateError);
        // Return token anyway, let the sync endpoint handle validation
        return c.json({
          success: true,
          accessToken: tokenData.access_token,
          twitchUserId: null
        });
      }
    }

    return c.json({
      success: true,
      accessToken: tokenData.access_token
    });
  } catch (error) {
    console.error(`Error getting saved token:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to get saved token',
      details: errorMessage 
    }, 500);
  }
});

// Save OAuth token to database
app.post('/contacts/save-token', async (c) => {
  try {
    const { privyUserId, platform, accessToken, expiresIn, scope } = await c.req.json();
    
    if (!privyUserId || !platform || !accessToken) {
      return c.json({ error: 'Missing required fields: privyUserId, platform, accessToken' }, 400);
    }

    const client = getSupabaseClient();
    
    // Calculate expires_at if expiresIn is provided (in seconds)
    let expiresAt: string | null = null;
    if (expiresIn) {
      expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    }

    const { error } = await client
      .from('oauth_tokens')
      .upsert({
        user_id: privyUserId,
        platform: platform,
        access_token: accessToken,
        expires_at: expiresAt,
        scope: scope || null,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,platform'
      });

    if (error) {
      console.error('Error saving token:', error);
      return c.json({ error: 'Failed to save token', details: error.message }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error(`Error saving token:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to save token',
      details: errorMessage 
    }, 500);
  }
});

app.post('/contacts/get-twitch-token', async (c) => {
  try {
    const { privyUserId } = await c.req.json();
    
    if (!privyUserId) {
      return c.json({ error: 'Missing required field: privyUserId' }, 400);
    }

    const privyAppId = Deno.env.get('PRIVY_APP_ID');
    const privyAppSecret = Deno.env.get('PRIVY_APP_SECRET') || Deno.env.get('PRIVY_API_KEY');
    
    console.log('Privy credentials check:', {
      hasAppId: !!privyAppId,
      hasAppSecret: !!privyAppSecret,
      appIdLength: privyAppId?.length || 0,
      secretLength: privyAppSecret?.length || 0
    });
    
    if (!privyAppId || !privyAppSecret) {
      return c.json({ 
        error: 'Privy credentials not configured',
        details: 'Please set PRIVY_APP_ID and PRIVY_APP_SECRET (or PRIVY_API_KEY) in Edge Function secrets',
        found: {
          PRIVY_APP_ID: !!privyAppId,
          PRIVY_APP_SECRET: !!Deno.env.get('PRIVY_APP_SECRET'),
          PRIVY_API_KEY: !!Deno.env.get('PRIVY_API_KEY')
        }
      }, 500);
    }

    // Extract user ID from did:privy: format if needed
    let userId = privyUserId;
    if (privyUserId.startsWith('did:privy:')) {
      userId = privyUserId.replace('did:privy:', '');
    }

    console.log(`Fetching linked accounts for Privy user: ${userId}, App ID: ${privyAppId}`);

    // Privy API uses Basic Auth with App ID and App Secret
    // Also requires privy-app-id header
    const basicAuth = btoa(`${privyAppId}:${privyAppSecret}`);

    // Try the correct Privy API endpoint with Basic Auth and privy-app-id header
    const response = await fetch(`https://auth.privy.io/api/v1/apps/${privyAppId}/users/${userId}/linked_accounts`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'privy-app-id': privyAppId,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Privy API error: ${response.status}`, errorText.substring(0, 500));
      
      // Try alternative endpoint format with Basic Auth and privy-app-id header
      const altResponse = await fetch(`https://auth.privy.io/api/v1/users/${userId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'privy-app-id': privyAppId,
          'Content-Type': 'application/json',
        },
      });

      if (!altResponse.ok) {
        const altErrorText = await altResponse.text();
        throw new Error(`Privy API error: ${response.status}. Tried both endpoints. Last error: ${altErrorText.substring(0, 200)}`);
      }

      const altData = await altResponse.json();
      console.log('Alternative endpoint response (full):', JSON.stringify(altData, null, 2));
      
      // Try to find Twitch in linked accounts
      // Privy uses "linked_accounts" (snake_case) not "linkedAccounts"
      let linkedAccounts = [];
      if (Array.isArray(altData.linked_accounts)) {
        linkedAccounts = altData.linked_accounts;
      } else if (Array.isArray(altData.linkedAccounts)) {
        linkedAccounts = altData.linkedAccounts;
      } else if (Array.isArray(altData.accounts)) {
        linkedAccounts = altData.accounts;
      } else if (Array.isArray(altData)) {
        linkedAccounts = altData;
      } else if (altData.linked_accounts) {
        linkedAccounts = Array.isArray(altData.linked_accounts) ? altData.linked_accounts : [altData.linked_accounts];
      } else if (altData.linkedAccounts) {
        linkedAccounts = Array.isArray(altData.linkedAccounts) ? altData.linkedAccounts : [altData.linkedAccounts];
      }
      
      console.log('Alternative endpoint - Found accounts:', linkedAccounts.length);
      console.log('Alternative endpoint - Account details:', linkedAccounts.map((a: any) => ({
        type: a.type,
        provider: a.provider,
        providerType: a.providerType,
        subject: a.subject,
        id: a.id,
        username: a.username
      })));
      
      // Privy uses "twitch_oauth" as type, not just "twitch"
      const twitchLinked = linkedAccounts.find((account: any) => {
        const type = (account.type || '').toLowerCase();
        const provider = (account.provider || '').toLowerCase();
        const providerType = (account.providerType || '').toLowerCase();
        return type === 'twitch' || type === 'twitch_oauth' || 
               provider === 'twitch' || provider === 'twitch_oauth' ||
               providerType === 'twitch' || providerType === 'twitch_oauth';
      });

      if (!twitchLinked) {
        return c.json({ 
          error: 'Twitch account not linked to this Privy user',
          debug: {
            totalAccounts: linkedAccounts.length,
            accountTypes: linkedAccounts.map((a: any) => a.type || a.provider || 'unknown'),
            userId: userId,
            fullResponse: altData
          }
        }, 404);
      }

      console.log('Alternative endpoint - Twitch account found:', {
        type: twitchLinked.type,
        subject: twitchLinked.subject,
        username: twitchLinked.username,
        hasOAuthToken: !!(twitchLinked.oauthToken || twitchLinked.accessToken),
        allKeys: Object.keys(twitchLinked)
      });

      if (!twitchLinked.oauthToken && !twitchLinked.accessToken) {
        // Privy doesn't expose OAuth tokens via API for security
        return c.json({ 
          success: false,
          error: 'Twitch OAuth token not available through Privy API',
          message: 'Privy does not provide OAuth tokens through their API for security reasons.',
          twitchUserId: twitchLinked.subject || twitchLinked.id,
          twitchUsername: twitchLinked.username,
          suggestion: 'Use direct Twitch OAuth authorization flow'
        });
      }

      return c.json({
        success: true,
        accessToken: twitchLinked.oauthToken || twitchLinked.accessToken,
        twitchUserId: twitchLinked.subject || twitchLinked.id || twitchLinked.userId,
      });
    }

    const data = await response.json();
    console.log('Privy API response (full):', JSON.stringify(data, null, 2));
    
    // Handle array or object response
    // Privy uses "linked_accounts" (snake_case) not "linkedAccounts"
    let accounts = [];
    if (Array.isArray(data)) {
      accounts = data;
    } else if (data.linked_accounts && Array.isArray(data.linked_accounts)) {
      accounts = data.linked_accounts;
    } else if (data.linkedAccounts && Array.isArray(data.linkedAccounts)) {
      accounts = data.linkedAccounts;
    } else if (data.accounts && Array.isArray(data.accounts)) {
      accounts = data.accounts;
    } else if (data.data && Array.isArray(data.data)) {
      accounts = data.data;
    }
    
    console.log('Found accounts:', accounts.length);
    console.log('Account types:', accounts.map((a: any) => ({
      type: a.type,
      provider: a.provider,
      providerType: a.providerType,
      subject: a.subject,
      id: a.id,
      username: a.username
    })));
    
    // Privy uses "twitch_oauth" as type, not just "twitch"
    const twitchLinked = accounts.find((account: any) => {
      const type = (account.type || '').toLowerCase();
      const provider = (account.provider || '').toLowerCase();
      const providerType = (account.providerType || '').toLowerCase();
      return type === 'twitch' || type === 'twitch_oauth' || 
             provider === 'twitch' || provider === 'twitch_oauth' ||
             providerType === 'twitch' || providerType === 'twitch_oauth';
    });

    if (!twitchLinked) {
      return c.json({ 
        error: 'Twitch account not linked to this Privy user',
        debug: {
          totalAccounts: accounts.length,
          accountTypes: accounts.map((a: any) => a.type || a.provider || 'unknown'),
          fullResponse: data
        }
      }, 404);
    }

    // Privy does not provide OAuth tokens through API for security reasons
    // We need to use an alternative approach
    console.log('Twitch account found, but checking for OAuth token...');
    console.log('Twitch account details:', {
      type: twitchLinked.type,
      subject: twitchLinked.subject,
      username: twitchLinked.username,
      hasOAuthToken: !!(twitchLinked.oauthToken || twitchLinked.accessToken),
      allKeys: Object.keys(twitchLinked)
    });

    if (!twitchLinked.oauthToken && !twitchLinked.accessToken) {
      // Privy doesn't expose OAuth tokens via API for security
      // Return Twitch user ID so client can request token refresh or use alternative method
      return c.json({ 
        success: false,
        error: 'Twitch OAuth token not available through Privy API',
        message: 'Privy does not provide OAuth tokens through their API for security reasons.',
        twitchUserId: twitchLinked.subject || twitchLinked.id,
        twitchUsername: twitchLinked.username,
        suggestion: 'Use direct Twitch OAuth authorization flow'
      });
    }

    return c.json({
      success: true,
      accessToken: twitchLinked.oauthToken || twitchLinked.accessToken,
      twitchUserId: twitchLinked.subject || twitchLinked.id || twitchLinked.userId,
    });
  } catch (error) {
    console.error(`Error getting Twitch token:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to get Twitch access token',
      details: errorMessage 
    }, 500);
  }
});

app.post('/contacts/get-twitter-token', async (c) => {
  try {
    const { privyUserId } = await c.req.json();
    
    if (!privyUserId) {
      return c.json({ error: 'Missing required field: privyUserId' }, 400);
    }

    const privyAppId = Deno.env.get('PRIVY_APP_ID');
    const privyAppSecret = Deno.env.get('PRIVY_APP_SECRET') || Deno.env.get('PRIVY_API_KEY');
    
    if (!privyAppId || !privyAppSecret) {
      return c.json({ 
        error: 'Privy credentials not configured',
        details: 'Please set PRIVY_APP_ID and PRIVY_APP_SECRET (or PRIVY_API_KEY) in Edge Function secrets',
      }, 500);
    }

    let userId = privyUserId;
    if (privyUserId.startsWith('did:privy:')) {
      userId = privyUserId.replace('did:privy:', '');
    }

    const basicAuth = btoa(`${privyAppId}:${privyAppSecret}`);

    const response = await fetch(`https://auth.privy.io/api/v1/apps/${privyAppId}/users/${userId}/linked_accounts`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'privy-app-id': privyAppId,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      const altResponse = await fetch(`https://auth.privy.io/api/v1/users/${userId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'privy-app-id': privyAppId,
          'Content-Type': 'application/json',
        },
      });

      if (!altResponse.ok) {
        throw new Error(`Privy API error: ${response.status}`);
      }

      const altData = await altResponse.json();
      
      let linkedAccounts = [];
      if (Array.isArray(altData.linked_accounts)) {
        linkedAccounts = altData.linked_accounts;
      } else if (Array.isArray(altData.linkedAccounts)) {
        linkedAccounts = altData.linkedAccounts;
      } else if (Array.isArray(altData.accounts)) {
        linkedAccounts = altData.accounts;
      }
      
      const twitterLinked = linkedAccounts.find((account: any) => {
        const type = (account.type || '').toLowerCase();
        const provider = (account.provider || '').toLowerCase();
        return type === 'twitter' || type === 'twitter_oauth' || 
               provider === 'twitter' || provider === 'twitter_oauth';
      });

      if (!twitterLinked) {
        return c.json({ 
          error: 'Twitter account not linked to this Privy user',
        }, 404);
      }

      if (!twitterLinked.oauthToken && !twitterLinked.accessToken) {
        return c.json({ 
          success: false,
          error: 'Twitter OAuth token not available through Privy API',
          message: 'Privy does not provide OAuth tokens through their API for security reasons.',
          twitterUserId: twitterLinked.subject || twitterLinked.id,
          suggestion: 'Use direct Twitter OAuth authorization flow'
        });
      }

      return c.json({
        success: true,
        accessToken: twitterLinked.oauthToken || twitterLinked.accessToken,
        twitterUserId: twitterLinked.subject || twitterLinked.id,
      });
    }

    const data = await response.json();
    
    let accounts = [];
    if (Array.isArray(data)) {
      accounts = data;
    } else if (data.linked_accounts && Array.isArray(data.linked_accounts)) {
      accounts = data.linked_accounts;
    } else if (data.linkedAccounts && Array.isArray(data.linkedAccounts)) {
      accounts = data.linkedAccounts;
    } else if (data.accounts && Array.isArray(data.accounts)) {
      accounts = data.accounts;
    }
    
    const twitterLinked = accounts.find((account: any) => {
      const type = (account.type || '').toLowerCase();
      const provider = (account.provider || '').toLowerCase();
      return type === 'twitter' || type === 'twitter_oauth' || 
             provider === 'twitter' || provider === 'twitter_oauth';
    });

    if (!twitterLinked) {
      return c.json({ 
        error: 'Twitter account not linked to this Privy user',
      }, 404);
    }

    if (!twitterLinked.oauthToken && !twitterLinked.accessToken) {
      return c.json({ 
        success: false,
        error: 'Twitter OAuth token not available through Privy API',
        message: 'Privy does not provide OAuth tokens through their API for security reasons.',
        twitterUserId: twitterLinked.subject || twitterLinked.id,
        suggestion: 'Use direct Twitter OAuth authorization flow'
      });
    }

    return c.json({
      success: true,
      accessToken: twitterLinked.oauthToken || twitterLinked.accessToken,
      twitterUserId: twitterLinked.subject || twitterLinked.id,
    });
  } catch (error) {
    console.error(`Error getting Twitter token:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to get Twitter access token',
      details: errorMessage 
    }, 500);
  }
});

app.post('/contacts/twitter-exchange-code', async (c) => {
  try {
    const { code, redirectUri, codeVerifier } = await c.req.json();
    
    console.log('[TWITTER EXCHANGE] Received request data:', {
      hasCode: !!code,
      codeLength: code?.length || 0,
      codePreview: code ? `${code.substring(0, 20)}...` : 'none',
      redirectUri: redirectUri,
      hasCodeVerifier: !!codeVerifier,
      codeVerifierLength: codeVerifier?.length || 0,
    });
    
    if (!code || !redirectUri) {
      return c.json({ error: 'Missing required fields: code, redirectUri' }, 400);
    }

    const twitterClientId = Deno.env.get('TWITTER_CLIENT_ID') || Deno.env.get('VITE_TWITTER_CLIENT_ID');
    const twitterClientSecret = Deno.env.get('TWITTER_CLIENT_SECRET') || Deno.env.get('VITE_TWITTER_CLIENT_SECRET');
    
    if (!twitterClientId || !twitterClientSecret) {
      return c.json({ 
        error: 'Twitter credentials not configured',
        details: 'Please set TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET in Edge Function secrets',
      }, 500);
    }

    console.log('[TWITTER EXCHANGE] Environment check:', {
      hasTWITTER_CLIENT_ID: !!Deno.env.get('TWITTER_CLIENT_ID'),
      hasVITE_TWITTER_CLIENT_ID: !!Deno.env.get('VITE_TWITTER_CLIENT_ID'),
      hasTWITTER_CLIENT_SECRET: !!Deno.env.get('TWITTER_CLIENT_SECRET'),
      hasVITE_TWITTER_CLIENT_SECRET: !!Deno.env.get('VITE_TWITTER_CLIENT_SECRET'),
      clientIdLength: twitterClientId?.length || 0,
      clientSecretLength: twitterClientSecret?.length || 0,
      clientIdFull: twitterClientId || 'none',
      clientIdRaw: Deno.env.get('TWITTER_CLIENT_ID') || Deno.env.get('VITE_TWITTER_CLIENT_ID') || 'none',
    });
    
    console.log('[CLIENT_ID_CHECK] Full client_id being used:', twitterClientId || 'NOT_SET');
    console.log('[CLIENT_ID_CHECK] Expected client_id from client:', 'T3pFZGVLRHFxNVdiNVVQRW1iWlY6MTpjaQ');
    console.log('[CLIENT_ID_CHECK] Client IDs match:', twitterClientId === 'T3pFZGVLRHFxNVdiNVVQRW1iWlY6MTpjaQ');

    const tokenUrl = 'https://api.twitter.com/2/oauth2/token';
    const params = new URLSearchParams();
    params.append('code', code);
    params.append('grant_type', 'authorization_code');
    params.append('client_id', twitterClientId);
    params.append('redirect_uri', redirectUri);
    if (codeVerifier) {
      params.append('code_verifier', codeVerifier);
    }
    
    console.log('[TWITTER EXCHANGE] Token request params:', {
      tokenUrl: tokenUrl,
      redirectUri: redirectUri,
      hasCodeVerifier: !!codeVerifier,
      codeLength: code.length,
      paramsKeys: Array.from(params.keys()),
      bodyLength: params.toString().length,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${twitterClientId}:${twitterClientSecret}`)}`,
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Twitter token exchange error: ${response.status} ${response.statusText}. ${errorText}`);
    }

    const tokenData = await response.json();

    return c.json({
      success: true,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
    });
  } catch (error) {
    console.error(`Error exchanging Twitter code:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to exchange Twitter authorization code',
      details: errorMessage 
    }, 500);
  }
});

// Sync contacts from social media platforms
app.post('/contacts/sync', async (c) => {
  try {
    const requestData = await c.req.json();
    // userId -  Twitch/Twitter user ID (numeric) for API
    // walletAddress -  wallet address for saving to DB as user_id
    const { platform, userId, accessToken, clientId, privyUserId, walletAddress } = requestData;
    
    if (!platform || !userId) {
      return c.json({ error: 'Missing required fields: platform, userId' }, 400);
    }

    const client = getSupabaseClient();

    if (platform === 'twitch') {
      if (!accessToken || !clientId) {
        return c.json({ error: 'Missing required fields for Twitch: accessToken, clientId' }, 400);
      }

      //   wallet address for saving to DB (if provided), otherwise use userId
      // This is needed for compatibility with old data
      const dbUserId = walletAddress ? walletAddress.toLowerCase().trim() : userId;
      console.log('[TWITCH SYNC] Using userId for API:', userId, 'dbUserId for DB:', dbUserId);

      const TWITCH_API_BASE_URL = 'https://api.twitch.tv/helix';
      const allContacts: any[] = [];
      let cursor: string | undefined = undefined;

      do {
        const url = new URL(`${TWITCH_API_BASE_URL}/channels/followed`);
        // For Twitch API use numeric Twitch user ID
        url.searchParams.set('user_id', userId);
        if (cursor) {
          url.searchParams.set('after', cursor);
        }

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Client-Id': clientId,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Twitch API error: ${response.status} ${response.statusText}. ${errorText}`
          );
        }

        const data = await response.json();

        if (data.data && Array.isArray(data.data)) {
          allContacts.push(...data.data);
        }

        cursor = data.pagination?.cursor;
      } while (cursor);

      if (allContacts.length > 0) {
        // Save to DB with wallet address as user_id (for compatibility with personal_contacts)
        const records = allContacts.map((contact) => ({
          user_id: dbUserId, // Use wallet address for DB
          broadcaster_id: contact.broadcaster_id,
          broadcaster_login: contact.broadcaster_login,
          broadcaster_name: contact.broadcaster_name,
          followed_at: contact.followed_at ? new Date(contact.followed_at).toISOString() : null,
          synced_at: new Date().toISOString(),
        }));

        console.log('[TWITCH SYNC] Saving', records.length, 'contacts with user_id:', dbUserId);

        const { error: upsertError } = await client
          .from('twitch_followed')
          .upsert(records, {
            onConflict: 'user_id,broadcaster_id',
            ignoreDuplicates: false,
          });

        if (upsertError) {
          console.error('Error saving Twitch contacts:', upsertError);
          throw new Error(`Failed to save contacts: ${upsertError.message}`);
        }
      }

      // Save the access token to database for future use
      // Twitch tokens typically don't expire, but we'll save it anyway
      if (privyUserId) {
        try {
          await client
            .from('oauth_tokens')
            .upsert({
              user_id: privyUserId,
              platform: 'twitch',
              access_token: accessToken,
              expires_at: null, // Twitch tokens don't expire unless revoked
              scope: 'user:read:follows',
              updated_at: new Date().toISOString()
            }, {
              onConflict: 'user_id,platform'
            });
        } catch (tokenError) {
          console.error('Error saving token (non-critical):', tokenError);
          // Don't fail the sync if token saving fails
        }
      }

      return c.json({
        success: true,
        platform: 'twitch',
        contactsCount: allContacts.length,
        contacts: allContacts.map((c) => ({
          broadcaster_id: c.broadcaster_id,
          broadcaster_login: c.broadcaster_login,
          broadcaster_name: c.broadcaster_name,
          followed_at: c.followed_at,
        })),
      });
                      } else if (platform === 'twitter') {
        if (!accessToken) {
          return c.json({ error: 'Missing required fields for Twitter: accessToken' }, 400);
        }

        const TWITTER_API_BASE_URL = 'https://api.twitter.com/2';
        
        // Log token info for debugging (without exposing full token)
        console.log('[TWITTER SYNC] Token info:', {
          hasToken: !!accessToken,
          tokenLength: accessToken?.length || 0,
          tokenPrefix: accessToken ? `${accessToken.substring(0, 20)}...` : 'none',
          userIdParameter: userId,
        });
        
        // Check if userId looks like a Twitter user ID (numeric string, typically 15-20 digits)
        const isTwitterUserId = /^\d+$/.test(userId);
        let twitterUserId: string | null = null;
        
        if (isTwitterUserId) {
          // If userId is already a Twitter user ID, use it directly
          // This avoids the need for /users/me which requires specific scopes
          console.log('[TWITTER SYNC] Using userId parameter as Twitter user ID:', userId);
          twitterUserId = userId;
        } else {
          // Try to get user ID from /users/me endpoint as fallback
          // Note: This requires scopes: tweet.read users.read
          console.log('[TWITTER SYNC] Attempting to get user info from /users/me...');
          try {
            const meResponse = await fetch(`${TWITTER_API_BASE_URL}/users/me?user.fields=id,username,name`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
              },
            });

            if (meResponse.ok) {
              const meData = await meResponse.json();
              twitterUserId = meData.data?.id;
              console.log('[TWITTER SYNC] Successfully got user ID from /users/me:', twitterUserId);
            } else {
              const errorText = await meResponse.text();
              console.warn('[TWITTER SYNC] /users/me failed:', meResponse.status, errorText);
              console.warn('[TWITTER SYNC] This might be due to missing scopes (requires: tweet.read users.read)');
              // Fallback to userId parameter if available
              if (userId) {
                console.log('[TWITTER SYNC] Falling back to using userId parameter:', userId);
                twitterUserId = userId;
              } else {
                throw new Error(
                  `Cannot determine Twitter user ID. /users/me returned ${meResponse.status}: ${errorText}. ` +
                  `Please ensure your token has scopes: tweet.read users.read follows.read, or provide userId as Twitter user ID.`
                );
              }
            }
          } catch (meError) {
            console.error('[TWITTER SYNC] Error calling /users/me:', meError);
            // Fallback to userId parameter if available
            if (userId) {
              console.log('[TWITTER SYNC] Falling back to using userId parameter due to error:', userId);
              twitterUserId = userId;
            } else {
              throw new Error(`Failed to get Twitter user ID: ${meError instanceof Error ? meError.message : 'Unknown error'}`);
            }
          }
        }

        if (!twitterUserId) {
          throw new Error('Could not determine Twitter user ID. Please provide userId as Twitter user ID (numeric string).');
        }

        console.log('[TWITTER SYNC] Using Twitter user ID for following request:', twitterUserId);

        const allContacts: any[] = [];
        let paginationToken: string | undefined = undefined;

        do {
          // Use the Twitter user ID from /users/me, not the userId parameter
          const url = new URL(`${TWITTER_API_BASE_URL}/users/${twitterUserId}/following`);
          url.searchParams.set('max_results', '1000');
          if (paginationToken) {
            url.searchParams.set('pagination_token', paginationToken);
          }

          console.log('[TWITTER SYNC] Fetching following list:', url.toString());

          const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
            },
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error('[TWITTER SYNC] Failed to get following list:', response.status, errorText);
            throw new Error(
              `Twitter API error: ${response.status} ${response.statusText}. ${errorText}`
            );
          }

          const data = await response.json();

        if (data.data && Array.isArray(data.data)) {
          allContacts.push(...data.data);
        }

        paginationToken = data.meta?.next_token;
      } while (paginationToken);

                if (allContacts.length > 0) {
          console.log('[TWITTER SYNC] Saving', allContacts.length, 'contacts to database');
          // Use wallet address for saving to DB (if provided), otherwise use userId
          // This is needed for compatibility with old data
          const dbUserId = walletAddress ? walletAddress.toLowerCase().trim() : userId;
          console.log('[TWITTER SYNC] Using twitterUserId for API:', twitterUserId, 'dbUserId for DB:', dbUserId);
          
          const records = allContacts.map((contact) => ({
            user_id: dbUserId, // Use wallet address for DB
            twitter_user_id: contact.id,
            username: contact.username,
            display_name: contact.name,
            followed_at: new Date().toISOString(),
            synced_at: new Date().toISOString(),
          }));

        const { error: upsertError } = await client
          .from('twitter_followed')
          .upsert(records, {
            onConflict: 'user_id,twitter_user_id',
            ignoreDuplicates: false,
          });

        if (upsertError) {
          console.error('Error saving Twitter contacts:', upsertError);
          throw new Error(`Failed to save contacts: ${upsertError.message}`);
        }
      }

      if (privyUserId) {
        try {
          await client
            .from('oauth_tokens')
            .upsert({
              user_id: privyUserId,
              platform: 'twitter',
              access_token: accessToken,
              expires_at: null,
              scope: 'users.read follows.read',
              updated_at: new Date().toISOString()
            }, {
              onConflict: 'user_id,platform'
            });
        } catch (tokenError) {
          console.error('Error saving token (non-critical):', tokenError);
        }
      }

      return c.json({
        success: true,
        platform: 'twitter',
        contactsCount: allContacts.length,
        contacts: allContacts.map((c) => ({
          twitter_user_id: c.id,
          username: c.username,
          display_name: c.name,
          followed_at: new Date().toISOString(),
        })),
      });
    } else if (platform === 'telegram') {
      const telegramUserIdRaw = requestData.telegramUserId ?? userId;
      const telegramUserId = normalizeTelegramId(telegramUserIdRaw);
      const dbUserId = walletAddress ? walletAddress.toLowerCase().trim() : telegramUserId;

      if (!telegramUserId) {
        return c.json({ error: 'Missing required field: telegramUserId' }, 400);
      }

      if (!dbUserId) {
        return c.json({ error: 'Unable to determine database user_id for Telegram sync' }, 400);
      }

      const client = getSupabaseClient();

      let contactsPayload: any[] | null = Array.isArray(requestData.contacts) ? requestData.contacts : null;

      if (!contactsPayload) {
        const serviceUrl = Deno.env.get('TELEGRAM_CONTACTS_SERVICE_URL');
        const serviceApiKey = Deno.env.get('TELEGRAM_CONTACTS_SERVICE_API_KEY');

        if (!serviceUrl) {
          return c.json({
            error: 'Telegram contacts service not configured',
            details: 'Set TELEGRAM_CONTACTS_SERVICE_URL or provide contacts array in request body',
          }, 500);
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        if (serviceApiKey) {
          headers['Authorization'] = `Bearer ${serviceApiKey}`;
        }

        const servicePayload = {
          telegramUserId,
          privyUserId: normalizePrivyUserId(privyUserId),
          walletAddress: dbUserId,
          username: requestData.telegramUsername ?? requestData.username ?? null,
          authData: requestData.authData ?? requestData.telegramAuthData ?? null,
          metadata: requestData.telegramProfile ?? requestData.profile ?? null,
        };

        try {
          const serviceResponse = await fetch(serviceUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(servicePayload),
          });

          if (!serviceResponse.ok) {
            const errorText = await serviceResponse.text();
            throw new Error(`Telegram contacts service error: ${serviceResponse.status} ${serviceResponse.statusText}. ${errorText}`);
          }

          const serviceData = await serviceResponse.json();
          if (Array.isArray(serviceData?.contacts)) {
            contactsPayload = serviceData.contacts;
          } else if (Array.isArray(serviceData)) {
            contactsPayload = serviceData;
          } else {
            contactsPayload = [];
          }
        } catch (error) {
          console.error('[TELEGRAM SYNC] Failed to fetch contacts from service:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          return c.json({ error: 'Failed to fetch Telegram contacts', details: errorMessage }, 500);
        }
      }

      const uniqueContacts = new Map<string, any>();
      const nowIso = new Date().toISOString();

      (contactsPayload || []).forEach((contactRaw) => {
        const contactId = normalizeTelegramId(
          contactRaw?.telegram_user_id ??
          contactRaw?.telegramUserId ??
          contactRaw?.id ??
          contactRaw?.user_id ??
          contactRaw?.userId ??
          contactRaw?.chat_id ??
          contactRaw?.chatId
        );

        if (!contactId) {
          return;
        }

        if (uniqueContacts.has(contactId)) {
          return;
        }

        const firstName = contactRaw?.first_name ?? contactRaw?.firstName ?? null;
        const lastName = contactRaw?.last_name ?? contactRaw?.lastName ?? null;
        const username = contactRaw?.username ?? contactRaw?.handle ?? contactRaw?.telegram_username ?? null;
        const displayNameSource = contactRaw?.display_name ?? contactRaw?.displayName ?? null;
        const displayNameFallback = [firstName, lastName].filter(Boolean).join(' ').trim();
        const displayName = (displayNameSource && String(displayNameSource).trim().length > 0)
          ? String(displayNameSource).trim()
          : (displayNameFallback.length > 0 ? displayNameFallback : (username || contactId));

        uniqueContacts.set(contactId, {
          telegram_user_id: contactId,
          username,
          first_name: firstName,
          last_name: lastName,
          display_name: displayName,
          phone_number: contactRaw?.phone_number ?? contactRaw?.phoneNumber ?? null,
          avatar_url: contactRaw?.avatar_url ?? contactRaw?.avatarUrl ?? contactRaw?.photo_url ?? contactRaw?.photoUrl ?? null,
          is_bot: typeof contactRaw?.is_bot === 'boolean' ? contactRaw.is_bot : (typeof contactRaw?.isBot === 'boolean' ? contactRaw.isBot : null),
          language_code: contactRaw?.language_code ?? contactRaw?.languageCode ?? null,
          synced_at: contactRaw?.synced_at ?? contactRaw?.syncedAt ?? nowIso,
        });
      });

      const contactsArray = Array.from(uniqueContacts.values());

      if (contactsArray.length > 0) {
        const records = contactsArray.map((contact) => ({
          user_id: dbUserId,
          telegram_user_id: contact.telegram_user_id,
          username: contact.username,
          first_name: contact.first_name,
          last_name: contact.last_name,
          display_name: contact.display_name,
          phone_number: contact.phone_number,
          avatar_url: contact.avatar_url,
          is_bot: contact.is_bot,
          language_code: contact.language_code,
          synced_at: contact.synced_at ? new Date(contact.synced_at).toISOString() : nowIso,
          updated_at: nowIso,
        }));

        const { error: upsertError } = await client
          .from('telegram_contacts')
          .upsert(records, {
            onConflict: 'user_id,telegram_user_id',
            ignoreDuplicates: false,
          });

        if (upsertError) {
          console.error('Error saving Telegram contacts:', upsertError);
          throw new Error(`Failed to save Telegram contacts: ${upsertError.message}`);
        }
      }

      return c.json({
        success: true,
        platform: 'telegram',
        contactsCount: contactsArray.length,
        contacts: contactsArray,
      });
    } else {
      return c.json({ error: `Platform ${platform} is not yet supported` }, 400);
    }
  } catch (error) {
    console.error(`Error syncing contacts:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to sync contacts',
      details: errorMessage 
    }, 500);
  }
});

// Personal contacts endpoints (must be before /contacts/:platform to avoid route conflict)
// Save personal contact (bypasses RLS using service_role)
app.post('/contacts/personal', async (c) => {
  try {
    const { userId, name, wallet } = await c.req.json();
    
    if (!userId || !name || !wallet) {
      return c.json({ 
        error: 'Missing required fields',
        required: ['userId', 'name', 'wallet']
      }, 400);
    }

    const client = getSupabaseClient();
    
    const { data, error } = await client
      .from('personal_contacts')
      .upsert(
        {
          user_id: userId,
          name: name.trim(),
          wallet: wallet.trim(),
        },
        {
          onConflict: 'user_id,wallet',
          ignoreDuplicates: false,
        }
      )
      .select();

    if (error) {
      console.error('[PERSONAL CONTACT] Error saving:', error);
      return c.json({ 
        error: 'Failed to save personal contact',
        details: error.message 
      }, 500);
    }

    return c.json({
      success: true,
      data: data?.[0] || null,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[PERSONAL CONTACT] Unexpected error:', errorMessage);
    return c.json({ 
      error: 'Internal server error',
      details: errorMessage 
    }, 500);
  }
});

// Get personal contacts (bypasses RLS using service_role)
app.get('/contacts/personal', async (c) => {
  try {
    const userId = c.req.query('userId');
    
    console.log('[PERSONAL CONTACT GET] Request received:', { userId, path: c.req.path, method: c.req.method });
    
    if (!userId) {
      console.log('[PERSONAL CONTACT GET] Missing userId parameter');
      return c.json({ 
        error: 'Missing required parameter',
        required: ['userId']
      }, 400);
    }

    const client = getSupabaseClient();
    
    // Normalize userId to lowercase for consistent comparison
    const normalizedUserId = userId.toLowerCase().trim();
    console.log('[PERSONAL CONTACT GET] Querying with normalized userId:', normalizedUserId);
    
    const { data, error } = await client
      .from('personal_contacts')
      .select('*')
      .eq('user_id', normalizedUserId)
      .order('is_favorite', { ascending: false })
      .order('name', { ascending: true });

    if (error) {
      console.error('[PERSONAL CONTACT GET] Database error:', error);
      return c.json({ 
        error: 'Failed to fetch personal contacts',
        details: error.message 
      }, 500);
    }

    console.log('[PERSONAL CONTACT GET] Successfully fetched', data?.length || 0, 'contacts');
    
    return c.json({
      success: true,
      data: data || [],
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[PERSONAL CONTACT GET] Unexpected error:', errorMessage, error);
    return c.json({ 
      error: 'Internal server error',
      details: errorMessage 
    }, 500);
  }
});

// Delete personal contact
app.delete('/contacts/personal', async (c) => {
  try {
    const { userId, wallet } = await c.req.json();
    
    if (!userId || !wallet) {
      return c.json({ 
        error: 'Missing required fields',
        required: ['userId', 'wallet']
      }, 400);
    }

    const client = getSupabaseClient();
    
    const { error } = await client
      .from('personal_contacts')
      .delete()
      .eq('user_id', userId)
      .eq('wallet', wallet);

    if (error) {
      console.error('[PERSONAL CONTACT] Error deleting:', error);
      return c.json({ 
        error: 'Failed to delete personal contact',
        details: error.message 
      }, 500);
    }

    return c.json({
      success: true,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[PERSONAL CONTACT] Unexpected error:', errorMessage);
    return c.json({ 
      error: 'Internal server error',
      details: errorMessage 
    }, 500);
  }
});

// Toggle favorite status for personal contact
app.patch('/contacts/personal/favorite', async (c) => {
  try {
    const { userId, wallet, isFavorite } = await c.req.json();
    
    console.log('[PERSONAL CONTACT FAVORITE] Request received:', { userId, wallet, isFavorite });
    
    if (!userId || !wallet || typeof isFavorite !== 'boolean') {
      return c.json({ 
        error: 'Missing required fields',
        required: ['userId', 'wallet', 'isFavorite']
      }, 400);
    }

    const client = getSupabaseClient();
    
    // Find record by wallet (user_id is now wallet address)
    // Normalize wallet address for comparison
    const normalizedWallet = wallet.toLowerCase().trim();
    const normalizedUserId = userId.toLowerCase().trim();
    
    // Try to find by user_id (wallet address) and contact wallet
    // Since user_id is now wallet address, we search by user_id matching the contact's wallet owner
    let existingRecord = null;
    
    // First attempt: find by user_id (which should be the wallet address of the owner)
    // and the contact's wallet address
    const { data: recordsByUserAndWallet, error: selectError1 } = await client
      .from('personal_contacts')
      .select('id, user_id, wallet, is_favorite')
      .eq('user_id', normalizedUserId)
      .eq('wallet', normalizedWallet)
      .limit(1);

    if (recordsByUserAndWallet && recordsByUserAndWallet.length > 0) {
      existingRecord = recordsByUserAndWallet[0] as any;
      console.log('[PERSONAL CONTACT FAVORITE] Found record by userId and wallet:', existingRecord);
    } else {
      // Second attempt: find by wallet only (in case user_id was different before migration)
      console.log('[PERSONAL CONTACT FAVORITE] Record not found by userId and wallet, trying wallet only...');
      const { data: recordsByWallet, error: selectError2 } = await client
        .from('personal_contacts')
        .select('id, user_id, wallet, is_favorite')
        .ilike('wallet', normalizedWallet)
        .limit(1);

      if (recordsByWallet && recordsByWallet.length > 0) {
        existingRecord = recordsByWallet[0] as any;
        console.log('[PERSONAL CONTACT FAVORITE] Found record by wallet only:', existingRecord);
        console.log('[PERSONAL CONTACT FAVORITE] Note: user_id mismatch. DB:', existingRecord.user_id, 'Request:', normalizedUserId);
        
        // Update user_id to wallet address (migration from old system)
        if (existingRecord && existingRecord.user_id !== normalizedUserId) {
          console.log('[PERSONAL CONTACT FAVORITE] Migrating user_id from', existingRecord.user_id, 'to wallet address:', normalizedUserId);
          const { error: updateUserIdError } = await client
            .from('personal_contacts')
            .update({ user_id: normalizedUserId })
            .eq('id', existingRecord.id);
          
          if (updateUserIdError) {
            console.error('[PERSONAL CONTACT FAVORITE] Error updating user_id:', updateUserIdError);
          } else {
            existingRecord.user_id = normalizedUserId;
            console.log('[PERSONAL CONTACT FAVORITE] user_id migrated successfully to wallet address');
          }
        }
      } else {
        console.error('[PERSONAL CONTACT FAVORITE] Record not found by wallet either. Errors:', selectError1, selectError2);
        return c.json({ 
          error: 'Contact not found',
          details: `No contact found with wallet: ${wallet}. Searched with userId (wallet): ${userId} and wallet only.`
        }, 404);
      }
    }

    if (!existingRecord) {
      console.error('[PERSONAL CONTACT FAVORITE] Record not found for:', { userId, wallet });
      return c.json({ 
        error: 'Contact not found',
        details: 'No contact found with the provided userId and wallet'
      }, 404);
    }

    console.log('[PERSONAL CONTACT FAVORITE] Found record:', existingRecord);
    const currentFavorite = (existingRecord as any).is_favorite || false;
    console.log('[PERSONAL CONTACT FAVORITE] Current is_favorite:', currentFavorite, 'New value:', isFavorite);
    
    // Check if update is needed
    if (currentFavorite === isFavorite) {
      console.log('[PERSONAL CONTACT FAVORITE] Value already set, no update needed');
      return c.json({
        success: true,
        message: 'Value already set',
        data: existingRecord,
      });
    }
    
    // Update the record - explicitly set updated_at to ensure trigger fires
    // Use id for update to ensure we update the correct record
    const { data: updatedData, error: updateError } = await client
      .from('personal_contacts')
      .update({ 
        is_favorite: isFavorite,
        updated_at: new Date().toISOString() // Explicitly update timestamp
      })
      .eq('id', (existingRecord as any).id)
      .select();

    if (updateError) {
      console.error('[PERSONAL CONTACT FAVORITE] Error updating favorite:', updateError);
      return c.json({ 
        error: 'Failed to update favorite status',
        details: updateError.message 
      }, 500);
    }

    if (!updatedData || updatedData.length === 0) {
      console.error('[PERSONAL CONTACT FAVORITE] No rows updated');
      return c.json({ 
        error: 'No rows updated',
        details: 'The update query did not affect any rows'
      }, 500);
    }

    console.log('[PERSONAL CONTACT FAVORITE] Update successful:', updatedData);

    return c.json({
      success: true,
      data: updatedData[0],
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[PERSONAL CONTACT FAVORITE] Unexpected error:', errorMessage);
    return c.json({ 
      error: 'Internal server error',
      details: errorMessage 
    }, 500);
  }
});

// Get synced contacts
app.get('/contacts/:platform', async (c) => {
  try {
    const platform = c.req.param('platform');
    const userId = c.req.query('userId');
    
    if (!userId) {
      return c.json({ error: 'Missing userId query parameter' }, 400);
    }

    const client = getSupabaseClient();

    if (platform === 'twitch') {
      const { data, error } = await client
        .from('twitch_followed')
        .select('*')
        .eq('user_id', userId)
        .order('is_favorite', { ascending: false })
        .order('broadcaster_name', { ascending: true });

      if (error) {
        throw new Error(`Failed to fetch contacts: ${error.message}`);
      }

      return c.json({
        success: true,
        platform: 'twitch',
        contacts: (data || []).map((row) => ({
          broadcaster_id: row.broadcaster_id,
          broadcaster_login: row.broadcaster_login,
          broadcaster_name: row.broadcaster_name,
          followed_at: row.followed_at,
          is_favorite: row.is_favorite || false,
        })),
      });
    } else if (platform === 'twitter') {
      const { data, error } = await client
        .from('twitter_followed')
        .select('*')
        .eq('user_id', userId)
        .order('is_favorite', { ascending: false })
        .order('display_name', { ascending: true });

      if (error) {
        throw new Error(`Failed to fetch contacts: ${error.message}`);
      }

      return c.json({
        success: true,
        platform: 'twitter',
        contacts: (data || []).map((row) => ({
          twitter_user_id: row.twitter_user_id,
          username: row.username,
          display_name: row.display_name,
          followed_at: row.followed_at,
          is_favorite: row.is_favorite || false,
        })),
      });
    } else if (platform === 'telegram') {
      const { data, error } = await client
        .from('telegram_contacts')
        .select('*')
        .eq('user_id', userId)
        .order('is_favorite', { ascending: false })
        .order('display_name', { ascending: true });

      if (error) {
        throw new Error(`Failed to fetch contacts: ${error.message}`);
      }

      return c.json({
        success: true,
        platform: 'telegram',
        contacts: (data || []).map((row) => ({
          telegram_user_id: row.telegram_user_id,
          username: row.username,
          first_name: row.first_name,
          last_name: row.last_name,
          display_name: row.display_name,
          phone_number: row.phone_number,
          avatar_url: row.avatar_url,
          is_bot: row.is_bot,
          language_code: row.language_code,
          synced_at: row.synced_at,
          is_favorite: row.is_favorite || false,
        })),
      });
    } else {
      return c.json({ error: `Platform ${platform} is not yet supported` }, 400);
    }
  } catch (error) {
    console.error(`Error fetching contacts:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to fetch contacts',
      details: errorMessage 
    }, 500);
  }
});

// Handler for all other routes (404)
app.notFound((c) => {
  console.log('Route not found:', c.req.method, c.req.path);
  return c.json({ 
    error: 'Route not found',
    method: c.req.method,
    path: c.req.path,
    availableRoutes: [
      'GET /',
      'POST /gift-cards/twitter/create',
      'GET /gift-cards/twitter/:username',
      'GET /gift-cards/twitter/by-token/:tokenId',
      'POST /gift-cards/twitter/:tokenId/claim',
      'POST /gift-cards/twitch/create',
      'GET /gift-cards/twitch/:username',
      'GET /gift-cards/twitch/by-token/:tokenId',
      'POST /gift-cards/twitch/:tokenId/claim',
      'POST /gift-cards/telegram/create',
      'GET /gift-cards/telegram/:username',
      'GET /gift-cards/telegram/by-token/:tokenId',
      'POST /gift-cards/telegram/:tokenId/claim',
      'POST /contacts/get-twitch-token',
      'POST /contacts/get-twitter-token',
      'POST /contacts/twitter-exchange-code',
      'POST /contacts/sync',
      'POST /contacts/personal',
      'GET /contacts/personal',
      'DELETE /contacts/personal',
      'PATCH /contacts/personal/favorite',
      'PATCH /contacts/social/favorite',
      'GET /contacts/:platform',
      'POST /wallets/create',
      'GET /wallets',
      'POST /wallets/link-telegram',
      'POST /wallets/create-for-social',
      'GET /wallets/get-by-social',
      'POST /wallets/send-transaction'
    ]
  }, 404);
});

// Developer-Controlled Wallet endpoints
// Create a Developer-Controlled Wallet for a user
app.post('/wallets/create', async (c) => {
  try {
    const { userId, blockchain = 'ARC-TESTNET', accountType = 'EOA' } = await c.req.json();
    
    if (!userId) {
      return c.json({ error: 'Missing required field: userId' }, 400);
    }

    // Validate blockchain
    const supportedBlockchains = ['ARC-TESTNET', 'ETH-SEPOLIA', 'BASE-SEPOLIA', 'MATIC-AMOY', 'SOL-DEVNET'];
    if (!supportedBlockchains.includes(blockchain)) {
      return c.json({ 
        error: 'Unsupported blockchain',
        supported: supportedBlockchains
      }, 400);
    }

    // Validate account type
    if (!['EOA', 'SCA'].includes(accountType)) {
      return c.json({ 
        error: 'Invalid account type',
        supported: ['EOA', 'SCA']
      }, 400);
    }

    // Check if user already has a wallet for this blockchain
    const client = getSupabaseClient();
    const { data: existingWallet } = await client
      .from('developer_wallets')
      .select('*')
      .eq('user_id', userId.toLowerCase())
      .eq('blockchain', blockchain)
      .single();

    if (existingWallet) {
      return c.json({
        success: true,
        wallet: existingWallet,
        message: 'Wallet already exists for this blockchain'
      });
    }

    // Get Circle API credentials from environment
    const circleApiKey = Deno.env.get('CIRCLE_API_KEY');
    const circleEntitySecretCiphertext = Deno.env.get('CIRCLE_ENTITY_SECRET_CIPHERTEXT');
    const circleEntitySecret = Deno.env.get('CIRCLE_ENTITY_SECRET'); // Fallback
    const circleWalletSetId = Deno.env.get('CIRCLE_WALLET_SET_ID');

    // Log environment variables status (without exposing values)
    console.log('Environment variables check:', {
      hasApiKey: !!circleApiKey,
      hasEntitySecretCiphertext: !!circleEntitySecretCiphertext,
      entitySecretCiphertextLength: circleEntitySecretCiphertext?.length || 0,
      hasEntitySecret: !!circleEntitySecret,
      entitySecretLength: circleEntitySecret?.length || 0,
      hasWalletSetId: !!circleWalletSetId
    });

    if (!circleApiKey) {
      return c.json({ 
        error: 'Circle API credentials not configured',
        details: 'Please set CIRCLE_API_KEY in Edge Function secrets'
      }, 500);
    }

    // Entity Secret Ciphertext is preferred, but we can use Entity Secret as fallback
    if (!circleEntitySecretCiphertext && !circleEntitySecret) {
      return c.json({ 
        error: 'Circle Entity Secret not configured',
        details: 'Please set CIRCLE_ENTITY_SECRET_CIPHERTEXT or CIRCLE_ENTITY_SECRET in Edge Function secrets'
      }, 500);
    }

    // Helper function moved to top-level: reEncryptEntitySecretCiphertextGlobal(circleApiKey, circleEntitySecret)

    // Create or get wallet set
    let walletSetId = circleWalletSetId;
    
    if (!walletSetId) {
      // Generate idempotency key for wallet set creation
      const idempotencyKey = crypto.randomUUID();
      
      // Entity Secret Ciphertext is required for wallet set creation
      // Re-encrypt it before each request
      let entitySecretCiphertextForRequest: string;
      if (circleEntitySecretCiphertext && circleEntitySecret) {
        try {
          // Try to re-encrypt the entity secret for this request
          entitySecretCiphertextForRequest = await reEncryptEntitySecretCiphertextGlobal(circleApiKey, circleEntitySecret);
        } catch (reEncryptError) {
          console.warn('Failed to re-encrypt entity secret, using existing ciphertext:', reEncryptError);
          // Fallback to existing ciphertext (may fail if reused)
          entitySecretCiphertextForRequest = circleEntitySecretCiphertext;
        }
      } else if (circleEntitySecretCiphertext) {
        // Use existing ciphertext (may fail if reused)
        entitySecretCiphertextForRequest = circleEntitySecretCiphertext;
      } else {
        return c.json({ 
          error: 'Circle Entity Secret Ciphertext required',
          details: 'CIRCLE_ENTITY_SECRET_CIPHERTEXT or CIRCLE_ENTITY_SECRET must be set in Edge Function secrets to create wallet sets'
        }, 500);
      }
      
      // Create a new wallet set for this user
      const walletSetResponse = await fetch('https://api.circle.com/v1/w3s/developer/walletSets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${circleApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `Wallet Set for ${userId.substring(0, 10)}...`,
          idempotencyKey: idempotencyKey,
          entitySecretCiphertext: entitySecretCiphertextForRequest
        })
      });

      if (!walletSetResponse.ok) {
        const errorText = await walletSetResponse.text();
        throw new Error(`Failed to create wallet set: ${walletSetResponse.status} ${errorText}`);
      }

      const walletSetData = await walletSetResponse.json();
      walletSetId = walletSetData.data?.walletSet?.id;
      
      if (!walletSetId) {
        throw new Error('Failed to get wallet set ID from response');
      }
    }

    // Re-encrypt Entity Secret Ciphertext for wallet creation
    // Circle requires a new ciphertext for each POST request
    let entitySecretCiphertextForWallet: string | undefined;
    
    if (circleEntitySecret) {
      try {
        // Try to re-encrypt the entity secret for this request
        entitySecretCiphertextForWallet = await reEncryptEntitySecretCiphertextGlobal(circleApiKey, circleEntitySecret);
      } catch (reEncryptError) {
        console.warn('Failed to re-encrypt entity secret for wallet creation:', reEncryptError);
        // Fallback to existing ciphertext if available
        if (circleEntitySecretCiphertext) {
          entitySecretCiphertextForWallet = circleEntitySecretCiphertext;
          console.warn('Using existing ciphertext (may fail if reused)');
        } else {
          // If we can't re-encrypt and don't have existing ciphertext, we can't proceed
          return c.json({ 
            error: 'Failed to generate entity secret ciphertext',
            details: 'Unable to re-encrypt entity secret and no existing ciphertext available. Please ensure CIRCLE_ENTITY_SECRET_CIPHERTEXT is set or fix the re-encryption process.'
          }, 500);
        }
      }
    } else if (circleEntitySecretCiphertext) {
      // If no entity secret but we have ciphertext, use it directly
      entitySecretCiphertextForWallet = circleEntitySecretCiphertext;
    } else {
      return c.json({ 
        error: 'Circle Entity Secret or Ciphertext required',
        details: 'Either CIRCLE_ENTITY_SECRET or CIRCLE_ENTITY_SECRET_CIPHERTEXT must be set in Edge Function secrets to create wallets'
      }, 500);
    }
    
    // Validate that we have ciphertext and it's not empty
    if (!entitySecretCiphertextForWallet || entitySecretCiphertextForWallet.trim().length === 0) {
      console.error('Entity Secret Ciphertext validation failed:', {
        isNull: entitySecretCiphertextForWallet === null,
        isUndefined: entitySecretCiphertextForWallet === undefined,
        isEmpty: entitySecretCiphertextForWallet === '',
        trimmedLength: entitySecretCiphertextForWallet?.trim().length || 0,
        hasCircleEntitySecret: !!circleEntitySecret,
        hasCircleEntitySecretCiphertext: !!circleEntitySecretCiphertext
      });
      return c.json({ 
        error: 'Entity Secret Ciphertext is required',
        details: 'Failed to obtain valid entity secret ciphertext for wallet creation. Please check your environment variables.'
      }, 500);
    }
    
    // Use Entity Secret Ciphertext (required for wallet creation)
    const entitySecretHeader: Record<string, string> = {
      'X-Entity-Secret-Ciphertext': entitySecretCiphertextForWallet
    };

    // Log for debugging (without exposing full secret)
    console.log('Creating wallet with:', {
      hasCiphertext: !!entitySecretCiphertextForWallet,
      ciphertextLength: entitySecretCiphertextForWallet.length,
      hasEntitySecret: !!circleEntitySecret,
      headerKey: 'X-Entity-Secret-Ciphertext',
      headerValueLength: entitySecretHeader['X-Entity-Secret-Ciphertext']?.length || 0,
      headerKeys: Object.keys(entitySecretHeader)
    });

    // Generate idempotency key for wallet creation
    const walletIdempotencyKey = crypto.randomUUID();

    // Prepare headers
    const requestHeaders: Record<string, string> = {
      'Authorization': `Bearer ${circleApiKey}`,
      'Content-Type': 'application/json',
      ...entitySecretHeader,
    };

    // Log headers (without exposing full secret)
    console.log('Request headers:', {
      hasAuth: !!requestHeaders['Authorization'],
      hasContentType: !!requestHeaders['Content-Type'],
      hasCiphertextHeader: !!requestHeaders['X-Entity-Secret-Ciphertext'],
      ciphertextHeaderLength: requestHeaders['X-Entity-Secret-Ciphertext']?.length || 0,
      allHeaderKeys: Object.keys(requestHeaders)
    });

    // Prepare request body
    const requestBody = {
      blockchains: [blockchain],
      count: 1,
      walletSetId: walletSetId,
      accountType: accountType,
      idempotencyKey: walletIdempotencyKey,
      entitySecretCiphertext: entitySecretCiphertextForWallet,
      metadata: [{
        name: `Wallet for ${userId.substring(0, 10)}...`,
        refId: userId
      }]
    };

    // Log request body (without exposing full secret)
    console.log('Request body:', {
      blockchains: requestBody.blockchains,
      count: requestBody.count,
      walletSetId: requestBody.walletSetId,
      accountType: requestBody.accountType,
      hasIdempotencyKey: !!requestBody.idempotencyKey,
      hasEntitySecretCiphertext: !!requestBody.entitySecretCiphertext,
      entitySecretCiphertextLength: requestBody.entitySecretCiphertext?.length || 0,
      metadataCount: requestBody.metadata?.length || 0
    });

    const createWalletResponse = await fetch('https://api.circle.com/v1/w3s/developer/wallets', {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });

    if (!createWalletResponse.ok) {
      const errorText = await createWalletResponse.text();
      console.error('Circle API error:', errorText);
      throw new Error(`Failed to create wallet: ${createWalletResponse.status} ${errorText}`);
    }

    const walletData = await createWalletResponse.json();
    const createdWallet = walletData.data?.wallets?.[0];

    if (!createdWallet) {
      throw new Error('No wallet returned from Circle API');
    }

    // Save wallet to database
    const { data: savedWallet, error: dbError } = await client
      .from('developer_wallets')
      .insert({
        user_id: userId.toLowerCase(),
        circle_wallet_id: createdWallet.id,
        circle_wallet_set_id: walletSetId,
        wallet_address: createdWallet.address,
        blockchain: createdWallet.blockchain,
        account_type: accountType,
        state: createdWallet.state || 'LIVE',
        custody_type: 'DEVELOPER'
      })
      .select()
      .single();

    if (dbError) {
      console.error('Database error:', dbError);
      throw new Error(`Failed to save wallet to database: ${dbError.message}`);
    }

    return c.json({
      success: true,
      wallet: savedWallet,
      circleWallet: createdWallet
    });
  } catch (error) {
    console.error('Error creating developer wallet:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to create developer wallet',
      details: errorMessage 
    }, 500);
  }
});

// Get user's developer wallets
app.get('/wallets', async (c) => {
  try {
    const userId = c.req.query('userId');
    
    if (!userId) {
      return c.json({ error: 'Missing required parameter: userId' }, 400);
    }

    const client = getSupabaseClient();
    
    const { data: wallets, error } = await client
      .from('developer_wallets')
      .select('*')
      .eq('user_id', userId.toLowerCase())
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch wallets: ${error.message}`);
    }

    return c.json({
      success: true,
      wallets: wallets || []
    });
  } catch (error) {
    console.error('Error fetching developer wallets:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to fetch developer wallets',
      details: errorMessage 
    }, 500);
  }
});

// Link Telegram ID to an existing developer wallet
app.post('/wallets/link-telegram', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));

    const walletAddressRaw = body.wallet_address ?? body.walletAddress;
    const blockchainRaw = body.blockchain;
    const telegramUserIdRaw = body.telegram_user_id ?? body.telegramUserId;
    const signature = body.signature;
    const message = body.message;
    const privyUserIdRaw = body.privy_user_id ?? body.privyUserId ?? body.privy_did ?? body.privyDid;
    const validateTelegram = Boolean(body.validateTelegram ?? body.validate_telegram);

    const walletAddress = normalizeWalletAddress(walletAddressRaw);
    const blockchain = normalizeBlockchain(blockchainRaw);
    const telegramUserId = normalizeTelegramId(telegramUserIdRaw);
    const privyUserId = normalizePrivyUserId(privyUserIdRaw);

    if (!walletAddress || !blockchain || !telegramUserId) {
      return c.json({
        error: 'Missing required fields',
        required: ['wallet_address', 'blockchain', 'telegram_user_id']
      }, 400);
    }

    const client = getSupabaseClient();

    const { data: walletRecord, error: walletError } = await client
      .from('developer_wallets')
      .select('*')
      .eq('wallet_address', walletAddress)
      .eq('blockchain', blockchain)
      .single();

    if (walletError || !walletRecord) {
      return c.json({
        error: 'Developer wallet not found',
        details: `No wallet with address ${walletAddress} on ${blockchain}`
      }, 404);
    }

    // Short-circuit if already linked to same Telegram ID
    if (walletRecord.telegram_user_id && walletRecord.telegram_user_id === telegramUserId) {
      return c.json({
        success: true,
        wallet: walletRecord,
        message: 'Wallet already linked to this Telegram ID'
      });
    }

    const verificationDetails: Record<string, unknown> = {};
    let ownershipVerified = false;
    let privyUserData: any = null;

    if (signature && message) {
      const expectedAddresses = [walletAddress];
      if (walletRecord.user_id) {
        expectedAddresses.push(String(walletRecord.user_id).toLowerCase());
      }

      const signatureResult = await verifyWalletOwnershipWithSignature(expectedAddresses, message, signature);
      verificationDetails.signature = signatureResult;
      ownershipVerified = signatureResult.success;
    }

    if (!ownershipVerified && privyUserId) {
      const privyResult = await verifyWalletOwnershipWithPrivy(privyUserId, walletAddress);
      verificationDetails.privy = privyResult;
      ownershipVerified = privyResult.success;
      if (privyResult.user) {
        privyUserData = privyResult.user;
      }
    }

    if (!ownershipVerified) {
      return c.json({
        error: 'Wallet ownership verification failed',
        details: 'Provide a valid signature or Privy user context to confirm wallet ownership',
        verification: verificationDetails
      }, 403);
    }

    let telegramValidation: Record<string, unknown> | null = null;
    if (validateTelegram) {
      if (!privyUserData && privyUserId) {
        const fetchResult = await fetchPrivyUserById(privyUserId);
        if (fetchResult.success) {
          privyUserData = fetchResult.user;
        } else {
          telegramValidation = {
            success: false,
            reason: fetchResult.reason || 'user_not_found'
          };
        }
      }

      if (privyUserData) {
        const telegramIds = extractPrivyTelegramIds(privyUserData);
        const matches = telegramIds.includes(telegramUserId);
        telegramValidation = {
          success: matches,
          telegramIds
        };

        if (!matches) {
          return c.json({
            error: 'Telegram validation failed',
            details: 'Provided Telegram ID does not belong to the Privy user',
            validation: telegramValidation
          }, 403);
        }
      }
    }

    // Check for conflicts where Telegram ID is already linked to another wallet
    const { data: conflictingWallets } = await client
      .from('developer_wallets')
      .select('id, wallet_address, blockchain, user_id')
      .eq('telegram_user_id', telegramUserId);

    const conflicting = (conflictingWallets || []).find((row) => row.id !== walletRecord.id);

    if (conflicting) {
      console.warn('Telegram ID already linked to another wallet', {
        telegramUserId,
        existingWalletAddress: conflicting.wallet_address,
        existingBlockchain: conflicting.blockchain,
        requestedWalletAddress: walletAddress,
        requestedBlockchain: blockchain,
      });
    }

    const { data: updatedWallet, error: updateError } = await client
      .from('developer_wallets')
      .update({ telegram_user_id: telegramUserId })
      .eq('id', walletRecord.id)
      .select()
      .single();

    if (updateError) {
      throw new Error(`Failed to update wallet: ${updateError.message}`);
    }

    return c.json({
      success: true,
      wallet: updatedWallet,
      verification: verificationDetails,
      telegramValidation,
      conflict: conflicting ? {
        wallet_address: conflicting.wallet_address,
        blockchain: conflicting.blockchain,
        user_id: conflicting.user_id
      } : null
    });
  } catch (error) {
    console.error('Error linking Telegram ID:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      error: 'Failed to link Telegram ID',
      details: errorMessage
    }, 500);
  }
});

// Request testnet tokens for a wallet
app.post('/wallets/request-testnet-tokens', async (c) => {
  try {
    const { walletAddress, blockchain } = await c.req.json();
    
    if (!walletAddress) {
      return c.json({ error: 'Missing required field: walletAddress' }, 400);
    }

    if (!blockchain) {
      return c.json({ error: 'Missing required field: blockchain' }, 400);
    }

    // Validate that blockchain is a testnet
    const testnetBlockchains = ['ARC-TESTNET', 'ETH-SEPOLIA', 'BASE-SEPOLIA', 'MATIC-AMOY', 'OP-SEPOLIA', 'ARB-SEPOLIA', 'AVAX-FUJI', 'SOL-DEVNET', 'UNI-SEPOLIA'];
    if (!testnetBlockchains.includes(blockchain)) {
      return c.json({ 
        error: 'Invalid blockchain',
        message: 'Testnet tokens can only be requested for testnet blockchains',
        supported: testnetBlockchains
      }, 400);
    }

    // Get Circle API credentials
    const circleApiKey = Deno.env.get('CIRCLE_API_KEY');
    
    if (!circleApiKey) {
      return c.json({ 
        error: 'Circle API credentials not configured',
        details: 'Please set CIRCLE_API_KEY in Edge Function secrets'
      }, 500);
    }

    // Map blockchain to Circle's testnet format
    const blockchainMap: Record<string, string> = {
      'ARC-TESTNET': 'ARC-TESTNET',
      'ETH-SEPOLIA': 'ETH-SEPOLIA',
      'BASE-SEPOLIA': 'BASE-SEPOLIA',
      'MATIC-AMOY': 'MATIC-AMOY',
      'OP-SEPOLIA': 'OP-SEPOLIA',
      'ARB-SEPOLIA': 'ARB-SEPOLIA',
      'AVAX-FUJI': 'AVAX-FUJI',
      'SOL-DEVNET': 'SOL-DEVNET',
      'UNI-SEPOLIA': 'UNI-SEPOLIA'
    };

    const circleBlockchain = blockchainMap[blockchain] || blockchain;

    // Request testnet tokens (USDC and EURC)
    // Note: Circle API uses /v1/faucet/drips endpoint for programmatic faucet requests
    // For Developer-Controlled Wallets, we need to use the correct endpoint
    const response = await fetch('https://api.circle.com/v1/faucet/drips', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${circleApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address: walletAddress,
        blockchain: circleBlockchain,
        usdc: true,
        eurc: true,
        native: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Circle API error:', errorText);
      // 403 Forbidden: programmatic faucet requires Circle mainnet-upgraded account (see Circle docs)
      if (response.status === 403) {
        return c.json({
          error: 'Faucet not available (Circle account)',
          details: 'Programmatic testnet faucet requires a Circle mainnet-upgraded account. Use the public faucet instead.',
          code: 'CIRCLE_FAUCET_FORBIDDEN',
          faucetUrl: 'https://faucet.circle.com'
        }, 403);
      }
      // 429: rate limit (can apply per-key/app even if user did not call recently)
      if (response.status === 429) {
        return c.json({
          error: 'Faucet rate limit',
          details: 'Circle API rate limit reached. Use the public faucet to get testnet tokens.',
          code: 'CIRCLE_FAUCET_RATE_LIMIT',
          faucetUrl: 'https://faucet.circle.com'
        }, 429);
      }
      throw new Error(`Failed to request testnet tokens: ${response.status} ${errorText}`);
    }

    // The API returns void, so we just check if it was successful
    return c.json({
      success: true,
      message: 'Testnet tokens requested successfully. USDC and EURC tokens will be sent to your wallet shortly.'
    });
  } catch (error) {
    console.error('Error requesting testnet tokens:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to request testnet tokens',
      details: errorMessage 
    }, 500);
  }
});

// TwitchCardVault ABI for contract function calls
// ABI for all Vault contracts (they all expose the same claimCard function)
const TwitchCardVaultABI = [
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "internalType": "string",
        "name": "username",
        "type": "string"
      },
      {
        "internalType": "address",
        "name": "claimer",
        "type": "address"
      }
    ],
    "name": "claimCard",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

// Twitter and Telegram use the same ABI
const TwitterCardVaultABI = TwitchCardVaultABI;
const TelegramCardVaultABI = TwitchCardVaultABI;

// ABI for the main GiftCard contract (create and redeem functions)
const GiftCardABI = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_recipient",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "_amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "_token",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "_metadataURI",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "_message",
        "type": "string"
      }
    ],
    "name": "createGiftCard",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "redeemGiftCard",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "_username",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "_amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "_token",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "_metadataURI",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "_message",
        "type": "string"
      }
    ],
    "name": "createGiftCardForTwitter",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "_username",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "_amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "_token",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "_metadataURI",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "_message",
        "type": "string"
      }
    ],
    "name": "createGiftCardForTwitch",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "_username",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "_amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "_token",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "_metadataURI",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "_message",
        "type": "string"
      }
    ],
    "name": "createGiftCardForTelegram",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "_username",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "_amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "_token",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "_metadataURI",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "_message",
        "type": "string"
      }
    ],
    "name": "createGiftCardForTikTok",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "_username",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "_amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "_token",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "_metadataURI",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "_message",
        "type": "string"
      }
    ],
    "name": "createGiftCardForInstagram",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

// ERC-20 allowance helpers (Circle USDC uses increaseAllowance for CCTP v2 bridge approve step)
const ERC20_ALLOWANCE_ABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "spender", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "name": "approve",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "spender", "type": "address" },
      { "internalType": "uint256", "name": "increment", "type": "uint256" }
    ],
    "name": "increaseAllowance",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "spender", "type": "address" },
      { "internalType": "uint256", "name": "decrement", "type": "uint256" }
    ],
    "name": "decreaseAllowance",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

const ERC20_ALLOWANCE_FUNCTION_NAMES = new Set([
  'approve',
  'increaseAllowance',
  'decreaseAllowance',
]);

// CCTP v2 TokenMessenger / MessageTransmitter (Internal Wallet bridge burn & mint)
const CCTP_V2_BRIDGE_ABI = [
  {
    "inputs": [
      { "internalType": "uint256", "name": "amount", "type": "uint256" },
      { "internalType": "uint32", "name": "destinationDomain", "type": "uint32" },
      { "internalType": "bytes32", "name": "mintRecipient", "type": "bytes32" },
      { "internalType": "address", "name": "burnToken", "type": "address" },
      { "internalType": "bytes32", "name": "destinationCaller", "type": "bytes32" },
      { "internalType": "uint256", "name": "maxFee", "type": "uint256" },
      { "internalType": "uint32", "name": "minFinalityThreshold", "type": "uint32" }
    ],
    "name": "depositForBurn",
    "outputs": [{ "internalType": "uint64", "name": "nonce", "type": "uint64" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256", "name": "amount", "type": "uint256" },
      { "internalType": "uint32", "name": "destinationDomain", "type": "uint32" },
      { "internalType": "bytes32", "name": "mintRecipient", "type": "bytes32" },
      { "internalType": "address", "name": "burnToken", "type": "address" },
      { "internalType": "bytes32", "name": "destinationCaller", "type": "bytes32" },
      { "internalType": "uint256", "name": "maxFee", "type": "uint256" },
      { "internalType": "uint32", "name": "minFinalityThreshold", "type": "uint32" },
      { "internalType": "bytes", "name": "hookData", "type": "bytes" }
    ],
    "name": "depositForBurnWithHook",
    "outputs": [{ "internalType": "uint64", "name": "nonce", "type": "uint64" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "bytes", "name": "message", "type": "bytes" },
      { "internalType": "bytes", "name": "attestation", "type": "bytes" }
    ],
    "name": "receiveMessage",
    "outputs": [{ "internalType": "bool", "name": "success", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

const CCTP_V2_FUNCTION_NAMES = new Set([
  'depositForBurn',
  'depositForBurnWithHook',
  'receiveMessage',
]);

/** Circle BridgingKit - Arc CCTP burn uses bridgeWithPreapproval on this contract (not TokenMessenger). */
const CIRCLE_BRIDGE_KIT_CONTRACT_LOWER = '0xc5567a5e3370d4dbfbf0540025078e283e36a363d';

const CIRCLE_BRIDGE_KIT_FUNCTION_NAMES = new Set([
  'bridgeWithPreapproval',
  'bridgeWithPreapprovalAndHook',
]);

const BRIDGE_PARAMS_COMPONENTS = [
  { internalType: 'uint256', name: 'amount', type: 'uint256' },
  { internalType: 'uint256', name: 'maxFee', type: 'uint256' },
  { internalType: 'uint256', name: 'fee', type: 'uint256' },
  { internalType: 'bytes32', name: 'mintRecipient', type: 'bytes32' },
  { internalType: 'bytes32', name: 'destinationCaller', type: 'bytes32' },
  { internalType: 'address', name: 'burnToken', type: 'address' },
  { internalType: 'address', name: 'feeRecipient', type: 'address' },
  { internalType: 'uint32', name: 'destinationDomain', type: 'uint32' },
  { internalType: 'uint32', name: 'minFinalityThreshold', type: 'uint32' },
];

const CIRCLE_BRIDGE_KIT_ABI = [
  {
    inputs: [
      {
        components: BRIDGE_PARAMS_COMPONENTS,
        internalType: 'struct BridgingKitContract.BridgeParams',
        name: 'bridgeParams',
        type: 'tuple',
      },
    ],
    name: 'bridgeWithPreapproval',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        components: BRIDGE_PARAMS_COMPONENTS,
        internalType: 'struct BridgingKitContract.BridgeParams',
        name: 'bridgeParams',
        type: 'tuple',
      },
      { internalType: 'bytes', name: 'hookData', type: 'bytes' },
    ],
    name: 'bridgeWithPreapprovalAndHook',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

// ZkSend ABI for createPayment, claimPayment, claimPayments (docs/smart-action-zksend-abi.md)
const ZkSendABI = [
  {
    "inputs": [
      { "internalType": "bytes32", "name": "_socialIdentityHash", "type": "bytes32" },
      { "internalType": "string", "name": "_platform", "type": "string" },
      { "internalType": "uint256", "name": "_amount", "type": "uint256" },
      { "internalType": "address", "name": "_token", "type": "address" }
    ],
    "name": "createPayment",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256", "name": "_paymentId", "type": "uint256" },
      {
        "components": [
          {
            "components": [
              { "internalType": "string", "name": "provider", "type": "string" },
              { "internalType": "string", "name": "parameters", "type": "string" },
              { "internalType": "string", "name": "context", "type": "string" }
            ],
            "internalType": "tuple",
            "name": "claimInfo",
            "type": "tuple"
          },
          {
            "components": [
              {
                "components": [
                  { "internalType": "bytes32", "name": "identifier", "type": "bytes32" },
                  { "internalType": "address", "name": "owner", "type": "address" },
                  { "internalType": "uint32", "name": "timestampS", "type": "uint32" },
                  { "internalType": "uint32", "name": "epoch", "type": "uint32" }
                ],
                "internalType": "tuple",
                "name": "claim",
                "type": "tuple"
              },
              { "internalType": "bytes[]", "name": "signatures", "type": "bytes[]" }
            ],
            "internalType": "tuple",
            "name": "signedClaim",
            "type": "tuple"
          }
        ],
        "internalType": "tuple",
        "name": "_proof",
        "type": "tuple"
      },
      { "internalType": "address", "name": "_recipient", "type": "address" }
    ],
    "name": "claimPayment",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256[]", "name": "_paymentIds", "type": "uint256[]" },
      {
        "components": [
          {
            "components": [
              { "internalType": "string", "name": "provider", "type": "string" },
              { "internalType": "string", "name": "parameters", "type": "string" },
              { "internalType": "string", "name": "context", "type": "string" }
            ],
            "internalType": "tuple",
            "name": "claimInfo",
            "type": "tuple"
          },
          {
            "components": [
              {
                "components": [
                  { "internalType": "bytes32", "name": "identifier", "type": "bytes32" },
                  { "internalType": "address", "name": "owner", "type": "address" },
                  { "internalType": "uint32", "name": "timestampS", "type": "uint32" },
                  { "internalType": "uint32", "name": "epoch", "type": "uint32" }
                ],
                "internalType": "tuple",
                "name": "claim",
                "type": "tuple"
              },
              { "internalType": "bytes[]", "name": "signatures", "type": "bytes[]" }
            ],
            "internalType": "tuple",
            "name": "signedClaim",
            "type": "tuple"
          }
        ],
        "internalType": "tuple",
        "name": "_proof",
        "type": "tuple"
      },
      { "internalType": "address", "name": "_recipient", "type": "address" }
    ],
    "name": "claimPayments",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

// DirectSend ABI for sendToAddress (docs/smart-action-zksend-abi.md)
const DirectSendABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "_recipient", "type": "address" },
      { "internalType": "uint256", "name": "_amount", "type": "uint256" },
      { "internalType": "address", "name": "_token", "type": "address" }
    ],
    "name": "sendToAddress",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

function abiInputToSignatureType(input: any): string {
  if (input.type === 'tuple' && Array.isArray(input.components)) {
    return `(${input.components.map((c: any) => abiInputToSignatureType(c)).join(',')})`;
  }
  return input.type;
}

// Helper function to get function signature
function getFunctionSignature(functionName: string, abi: any[]): string {
  const func = abi.find((item: any) => item.name === functionName && item.type === 'function');
  if (!func) {
    throw new Error(`Function ${functionName} not found in ABI`);
  }
  
  const params = func.inputs.map((input: any) => abiInputToSignatureType(input)).join(',');
  return `${functionName}(${params})`;
}

function serializeCircleAbiArg(arg: any): any {
  if (typeof arg === 'bigint') {
    return arg.toString();
  }
  if (Array.isArray(arg)) {
    return arg.map(serializeCircleAbiArg);
  }
  if (arg !== null && typeof arg === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(arg)) {
      out[key] = serializeCircleAbiArg(value);
    }
    return out;
  }
  if (typeof arg === 'number') {
    return arg.toString();
  }
  return arg;
}

const ZKSEND_CLAIM_FUNCTION_NAMES = new Set(['claimPayment', 'claimPayments']);

function getZkSendContractAddressLower(): string {
  return (Deno.env.get('ZKSEND_CONTRACT_ADDRESS') || Deno.env.get('VITE_ARC_ZKSEND_CONTRACT_ADDRESS') || '')
    .trim()
    .toLowerCase();
}

/** Normalize JSON args for viem encodeFunctionData (ZkSend claim tuples). */
function parseArgForViem(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(parseArgForViem);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = parseArgForViem(val);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return value as `0x${string}`;
    if (/^\d+$/.test(value)) return BigInt(value);
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return value;
}

function coerceUint256Arg(value: unknown): unknown {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return value;
}

function parseZkSendClaimArgs(functionName: string, args: unknown[]): unknown[] {
  const parsed = args.map(parseArgForViem);
  if (functionName === 'claimPayment' && parsed.length > 0) {
    parsed[0] = coerceUint256Arg(parsed[0]);
  }
  if (functionName === 'claimPayments' && parsed.length > 0 && Array.isArray(parsed[0])) {
    parsed[0] = (parsed[0] as unknown[]).map(coerceUint256Arg);
  }
  return parsed;
}

function encodeZkSendClaimCallData(
  functionName: string,
  args: unknown[],
): { ok: true; callData: `0x${string}` } | { ok: false; error: string } {
  try {
    const viemArgs = parseZkSendClaimArgs(functionName, args);
    const callData = encodeFunctionData({
      abi: ZkSendABI,
      functionName: functionName as 'claimPayment' | 'claimPayments',
      args: viemArgs as any,
    });
    return { ok: true, callData };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Create Developer wallet for social account
app.post('/wallets/create-for-social', async (c) => {
  try {
    const {
      platform,
      socialUserId,
      socialUsername,
      privyUserId,
      blockchain = 'ARC-TESTNET',
      accessToken,
      oauth1TokenSecret,
    } = await c.req.json();
    
    // Validation
    if (!platform || !socialUserId || !socialUsername || !privyUserId) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    // Platform validation
    const supportedPlatforms = [...SOCIAL_WALLET_PLATFORMS];
    if (!supportedPlatforms.includes(platform)) {
      return c.json({ 
        error: 'Unsupported platform',
        supported: supportedPlatforms
      }, 400);
    }

    if (typeof privyUserId === 'string' && privyUserId.startsWith('zk-oauth:')) {
      if (!accessToken || typeof accessToken !== 'string' || accessToken.length < 10) {
        return c.json({ error: 'accessToken is required for zk OAuth wallet creation' }, 400);
      }
      const verified = await verifyZkOAuthToken(
        platform,
        accessToken,
        String(socialUserId),
        typeof oauth1TokenSecret === 'string' ? oauth1TokenSecret : undefined,
      );
      if (!verified) {
        console.warn('zk OAuth token verification failed', { platform, socialUserId, privyUserId });
        return c.json({ error: 'OAuth verification failed' }, 403);
      }
    }

    // Verification via Privy (optional; continue if it fails)
    let privyUserVerified = false;
    let privyUser: any = null;
    
    try {
      const privyResult = await fetchPrivyUserById(privyUserId);
      if (privyResult.success && privyResult.user) {
        privyUser = privyResult.user;
        // Check that the social account matches
        const socialAccount = await verifySocialAccount(privyResult.user, platform, socialUserId);
        privyUserVerified = socialAccount.verified;
        
        if (!privyUserVerified) {
          console.warn('Social account verification failed; continuing with wallet creation', {
            platform,
            socialUserId,
            privyUserId
          });
          // Do not block wallet creation; just log a warning
        }
      } else {
        console.warn('Failed to fetch Privy user; continuing with wallet creation', {
          privyUserId,
          reason: privyResult.reason
        });
      }
    } catch (privyError) {
      console.warn('Error verifying Privy user; continuing with wallet creation:', privyError);
      // Continue creating the wallet even if Privy verification failed
    }

    // Check if a wallet already exists
    const client = getSupabaseClient();
    const { data: existingWallet } = await client
      .from('developer_wallets')
      .select('*')
      .eq('social_platform', platform)
      .eq('social_user_id', socialUserId)
      .eq('blockchain', blockchain)
      .single();

    if (existingWallet) {
      return c.json({
        success: true,
        wallet: existingWallet,
        message: 'Wallet already exists'
      });
    }

    // Get Circle API credentials
    const circleApiKey = Deno.env.get('CIRCLE_API_KEY');
    const circleEntitySecretCiphertext = Deno.env.get('CIRCLE_ENTITY_SECRET_CIPHERTEXT');
    const circleEntitySecret = Deno.env.get('CIRCLE_ENTITY_SECRET');
    const circleWalletSetId = Deno.env.get('CIRCLE_WALLET_SET_ID');

    if (!circleApiKey) {
      return c.json({ 
        error: 'Circle API credentials not configured',
        details: 'Please set CIRCLE_API_KEY in Edge Function secrets'
      }, 500);
    }

    if (!circleEntitySecretCiphertext && !circleEntitySecret) {
      return c.json({ 
        error: 'Circle Entity Secret not configured',
        details: 'Please set CIRCLE_ENTITY_SECRET_CIPHERTEXT or CIRCLE_ENTITY_SECRET in Edge Function secrets'
      }, 500);
    }

    // Helper function moved to top-level: reEncryptEntitySecretCiphertextGlobal(circleApiKey, circleEntitySecret)

    // Ensure CIRCLE_ENTITY_SECRET is present (required for re-encryption)
    if (!circleEntitySecret) {
      return c.json({ 
        error: 'Circle Entity Secret required',
        details: 'CIRCLE_ENTITY_SECRET must be set in Edge Function secrets to re-encrypt entity secret ciphertext for each request. Circle API does not allow reusing old ciphertext.'
      }, 500);
    }

    // Create wallet set if needed
    let walletSetId = circleWalletSetId;
    
    if (!walletSetId) {
      const idempotencyKey = crypto.randomUUID();
      
      // Re-encrypt for wallet set creation
      let entitySecretCiphertextForWalletSet: string;
      try {
        entitySecretCiphertextForWalletSet = await reEncryptEntitySecretCiphertextGlobal(circleApiKey, circleEntitySecret);
        console.log('Successfully re-encrypted entity secret ciphertext for wallet set');
      } catch (reEncryptError) {
        console.error('Failed to re-encrypt entity secret for wallet set:', reEncryptError);
        return c.json({ 
          error: 'Failed to generate entity secret ciphertext for wallet set',
          details: 'Unable to re-encrypt entity secret for wallet set creation'
        }, 500);
      }
      
      const walletSetResponse = await fetch('https://api.circle.com/v1/w3s/developer/walletSets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${circleApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `Wallet Set for ${platform}:${socialUserId}`,
          idempotencyKey: idempotencyKey,
          entitySecretCiphertext: entitySecretCiphertextForWalletSet
        })
      });

      if (!walletSetResponse.ok) {
        const errorText = await walletSetResponse.text();
        throw new Error(`Failed to create wallet set: ${walletSetResponse.status} ${errorText}`);
      }

      const walletSetData = await walletSetResponse.json();
      walletSetId = walletSetData.data?.walletSet?.id;
      
      if (!walletSetId) {
        throw new Error('Failed to get wallet set ID from response');
      }
    }

    // Create wallet
    const walletIdempotencyKey = crypto.randomUUID();
    
    // Re-encrypt for wallet creation (fresh ciphertext required for every request)
    let entitySecretCiphertextForWalletCreation: string;
    try {
      entitySecretCiphertextForWalletCreation = await reEncryptEntitySecretCiphertextGlobal(circleApiKey, circleEntitySecret);
      console.log('Successfully re-encrypted entity secret ciphertext for wallet creation');
    } catch (reEncryptError) {
      console.error('Failed to re-encrypt entity secret for wallet creation:', reEncryptError);
      return c.json({ 
        error: 'Failed to generate entity secret ciphertext for wallet creation',
        details: 'Unable to re-encrypt entity secret. Circle API requires fresh ciphertext for each request.'
      }, 500);
    }
    
    const requestHeaders: Record<string, string> = {
      'Authorization': `Bearer ${circleApiKey}`,
      'Content-Type': 'application/json',
      'X-Entity-Secret-Ciphertext': entitySecretCiphertextForWalletCreation,
    };

    const requestBody = {
      blockchains: [blockchain],
      count: 1,
      walletSetId: walletSetId,
      accountType: 'EOA',
      idempotencyKey: walletIdempotencyKey,
      entitySecretCiphertext: entitySecretCiphertextForWalletCreation,
      metadata: [{
        name: `Wallet for ${platform}:${socialUsername}`,
        refId: `social:${platform}:${socialUserId}`
      }]
    };

    const createWalletResponse = await fetch('https://api.circle.com/v1/w3s/developer/wallets', {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });

    if (!createWalletResponse.ok) {
      const errorText = await createWalletResponse.text();
      console.error('Circle API error:', errorText);
      throw new Error(`Failed to create wallet: ${createWalletResponse.status} ${errorText}`);
    }

    const walletData = await createWalletResponse.json();
    const createdWallet = walletData.data?.wallets?.[0];

    if (!createdWallet) {
      throw new Error('No wallet returned from Circle API');
    }

    // Save to DB
    const { data: newWallet, error: dbError } = await client
      .from('developer_wallets')
      .insert({
        user_id: `social:${platform}:${socialUserId}`,
        user_type: `${platform}_id`,
        social_platform: platform,
        social_user_id: socialUserId,
        social_username: socialUsername,
        privy_user_id: privyUserId,
        circle_wallet_id: createdWallet.id,
        circle_wallet_set_id: walletSetId,
        wallet_address: createdWallet.address,
        blockchain: blockchain,
        account_type: 'EOA',
        state: createdWallet.state || 'LIVE',
        custody_type: 'DEVELOPER'
      })
      .select()
      .single();

    if (dbError) {
      console.error('Database error:', dbError);
      throw new Error(`Failed to save wallet to database: ${dbError.message}`);
    }

    return c.json({
      success: true,
      wallet: newWallet
    });
  } catch (error) {
    console.error('Error creating social wallet:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to create wallet',
      details: errorMessage
    }, 500);
  }
});

// Get wallet by social account
app.get('/wallets/get-by-social', async (c) => {
  try {
    const platform = c.req.query('platform');
    const socialUserId = c.req.query('socialUserId');
    const blockchain = c.req.query('blockchain') || 'ARC-TESTNET';
    
    if (!platform || !socialUserId) {
      return c.json({ error: 'Missing required parameters: platform, socialUserId' }, 400);
    }

    const supportedPlatforms = [...SOCIAL_WALLET_PLATFORMS];
    if (!supportedPlatforms.includes(platform)) {
      return c.json({
        error: 'Unsupported platform',
        supported: supportedPlatforms,
      }, 400);
    }

    const client = getSupabaseClient();
    const { data: wallet, error } = await client
      .from('developer_wallets')
      .select('*')
      .eq('social_platform', platform)
      .eq('social_user_id', socialUserId)
      .eq('blockchain', blockchain)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = not found
      throw new Error(`Failed to fetch wallet: ${error.message}`);
    }

    return c.json({
      success: true,
      wallet: wallet || null
    });
  } catch (error) {
    console.error('Error fetching wallet by social:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to fetch wallet',
      details: errorMessage 
    }, 500);
  }
});

// Send transaction via Developer wallet (CRITICAL)
app.post('/wallets/send-transaction', async (c) => {
  try {
    const body = await c.req.json();
    const { 
      walletId, 
      walletAddress, 
      contractAddress, 
      args, 
      blockchain,
      privyUserId,
      socialPlatform,
      socialUserId
    } = body;
    const callDataRaw = body?.callData ?? body?.call_data;
    const useCallData = typeof callDataRaw === 'string' && callDataRaw.startsWith('0x');
    const rawFunctionName = body?.functionName ?? body?.function_name;
    const functionName = rawFunctionName
      ? remapArcUsdcAllowanceFunction(blockchain, contractAddress, rawFunctionName)
      : undefined;

    if (!walletId || !walletAddress || !contractAddress || !blockchain) {
      return c.json({ 
        error: 'Missing required fields',
        required: ['walletId', 'walletAddress', 'contractAddress', 'blockchain']
      }, 400);
    }

    if (!useCallData && (!functionName || args === undefined || args === null)) {
      return c.json({
        error: 'Missing required fields',
        required: ['functionName', 'args'],
        hint: 'Or send pre-encoded callData for tuple-heavy contract calls',
      }, 400);
    }

    // Verify wallet ownership
    const client = getSupabaseClient();
    const { data: wallet } = await client
      .from('developer_wallets')
      .select('*')
      .eq('circle_wallet_id', walletId)
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();

    if (!wallet) {
      console.error('Wallet not found in database', { walletId, walletAddress });
      return c.json({ error: 'Wallet not found' }, 404);
    }

    console.log('Wallet found:', {
      walletId: wallet.circle_wallet_id,
      walletAddress: wallet.wallet_address,
      blockchain: wallet.blockchain,
      state: wallet.state,
      socialPlatform: wallet.social_platform,
      socialUserId: wallet.social_user_id,
      privyUserId: wallet.privy_user_id,
      userId: wallet.user_id
    });

    // Verify wallet ownership
    let ownershipVerified = false;
    const verificationDetails: Record<string, any> = {};

    // Method 1: Verify via social account
    if (socialPlatform && socialUserId) {
      const socialMatch = wallet.social_platform === socialPlatform && 
                         wallet.social_user_id === socialUserId;
      verificationDetails.social = {
        provided: { platform: socialPlatform, userId: socialUserId },
        wallet: { platform: wallet.social_platform, userId: wallet.social_user_id },
        match: socialMatch
      };
      
      if (socialMatch) {
        ownershipVerified = true;
        console.log('Wallet ownership verified via social account');
      } else {
        console.log('Social account verification failed:', verificationDetails.social);
      }
    }

    // Method 2: Verify via Privy or user_id (for wallets created with MetaMask address)
    if (!ownershipVerified && privyUserId) {
      // Check both privy_user_id and user_id (for wallets created with MetaMask address as user_id)
      const privyMatch = wallet.privy_user_id && wallet.privy_user_id.toLowerCase() === privyUserId.toLowerCase();
      const userIdMatch = wallet.user_id && wallet.user_id.toLowerCase() === privyUserId.toLowerCase();
      
      verificationDetails.privy = {
        provided: privyUserId,
        walletPrivyUserId: wallet.privy_user_id,
        walletUserId: wallet.user_id,
        privyMatch,
        userIdMatch
      };
      
      if (privyMatch || userIdMatch) {
        ownershipVerified = true;
        console.log('Wallet ownership verified via Privy/user ID');
      } else {
        console.log('Privy/user verification failed:', verificationDetails.privy);
      }
    }

    // Method 3: If wallet has social account info but no verification params provided,
    // check if this is a social-only wallet (no privy_user_id or user_id)
    if (!ownershipVerified && wallet.social_platform && wallet.social_user_id) {
      // This is a social-only wallet, require social verification
      if (!socialPlatform || !socialUserId) {
        console.log('Social-only wallet requires social verification, but no social params provided');
        return c.json({ 
          error: 'Wallet ownership verification failed',
          details: 'This wallet requires social account verification. Please provide socialPlatform and socialUserId.',
          verification: verificationDetails
        }, 403);
      }
    }

    // Method 4: If wallet has user_id but no social info, and no privyUserId provided,
    // this might be a wallet created with MetaMask address as user_id
    if (!ownershipVerified && wallet.user_id && !wallet.social_platform && !privyUserId) {
      // This wallet was likely created with MetaMask address as user_id
      // Since we don't have privyUserId, we can't verify, but we should allow if wallet exists
      // However, for security, we require at least one verification method
      console.log('Wallet requires user verification, but no privyUserId provided');
      return c.json({ 
        error: 'Wallet ownership verification failed',
        details: 'This wallet requires user verification. Please provide privyUserId.',
        verification: verificationDetails
      }, 403);
    }

    // Final check: if no verification method succeeded, reject
    if (!ownershipVerified) {
      console.log('All wallet ownership verification methods failed:', verificationDetails);
      return c.json({ 
        error: 'Wallet ownership verification failed',
        details: 'Unable to verify wallet ownership with provided credentials.',
        verification: verificationDetails
      }, 403);
    }

    // Get Circle API credentials
    const circleApiKey = Deno.env.get('CIRCLE_API_KEY');
    const circleEntitySecretCiphertext = Deno.env.get('CIRCLE_ENTITY_SECRET_CIPHERTEXT');
    const circleEntitySecret = Deno.env.get('CIRCLE_ENTITY_SECRET');

    if (!circleApiKey) {
      return c.json({ 
        error: 'Circle API credentials not configured',
        details: 'Please set CIRCLE_API_KEY in Edge Function secrets'
      }, 500);
    }

    if (!circleEntitySecretCiphertext && !circleEntitySecret) {
      return c.json({ 
        error: 'Circle Entity Secret not configured',
        details: 'Please set CIRCLE_ENTITY_SECRET_CIPHERTEXT or CIRCLE_ENTITY_SECRET in Edge Function secrets'
      }, 500);
    }

    console.log('Circle API credentials check:', {
      hasApiKey: !!circleApiKey,
      hasEntitySecretCiphertext: !!circleEntitySecretCiphertext,
      hasEntitySecret: !!circleEntitySecret,
      walletId: walletId,
      walletAddress: walletAddress,
      contractAddress: contractAddress,
      functionName: functionName,
      blockchain: blockchain
    });

    // Helper function moved to top-level: reEncryptEntitySecretCiphertextGlobal(circleApiKey, circleEntitySecret)

    // Re-encrypt Entity Secret Ciphertext
    let entitySecretCiphertextForRequest: string;
    
    if (circleEntitySecret) {
      try {
        entitySecretCiphertextForRequest = await reEncryptEntitySecretCiphertextGlobal(circleApiKey, circleEntitySecret);
      } catch (reEncryptError) {
        console.warn('Failed to re-encrypt entity secret:', reEncryptError);
        if (circleEntitySecretCiphertext) {
          entitySecretCiphertextForRequest = circleEntitySecretCiphertext;
        } else {
          return c.json({ 
            error: 'Failed to generate entity secret ciphertext',
            details: 'Unable to re-encrypt entity secret'
          }, 500);
        }
      }
    } else if (circleEntitySecretCiphertext) {
      entitySecretCiphertextForRequest = circleEntitySecretCiphertext;
    } else {
      return c.json({ 
        error: 'Circle Entity Secret or Ciphertext required',
        details: 'Either CIRCLE_ENTITY_SECRET or CIRCLE_ENTITY_SECRET_CIPHERTEXT must be set'
      }, 500);
    }

    // Check, that entitySecretCiphertextForRequest is not empty
    if (!entitySecretCiphertextForRequest || entitySecretCiphertextForRequest.trim() === '') {
      return c.json({ 
        error: 'Entity Secret Ciphertext is empty',
        details: 'Failed to generate or retrieve entity secret ciphertext. Please check CIRCLE_ENTITY_SECRET and CIRCLE_ENTITY_SECRET_CIPHERTEXT configuration.'
      }, 500);
    }

    console.log('Entity Secret Ciphertext prepared:', {
      hasCiphertext: !!entitySecretCiphertextForRequest,
      length: entitySecretCiphertextForRequest.length,
      preview: `${entitySecretCiphertextForRequest.substring(0, 20)}...`
    });

    // Choose the correct ABI based on contractAddress, functionName or socialPlatform
    let abiToUse: any[] = TwitchCardVaultABI; // Default
    const contractAddressLower = contractAddress.toLowerCase();

    if (!useCallData) {

    // ZkSend / DirectSend: select ABI by contract address (docs/smart-action-zksend-abi.md)
    const zkSendAddress = (Deno.env.get('ZKSEND_CONTRACT_ADDRESS') || Deno.env.get('VITE_ARC_ZKSEND_CONTRACT_ADDRESS') || '').trim().toLowerCase();
    const directSendAddress = (Deno.env.get('DIRECT_SEND_CONTRACT_ADDRESS') || Deno.env.get('VITE_ARC_DIRECT_SEND_CONTRACT_ADDRESS') || '').trim().toLowerCase();
    if (zkSendAddress && contractAddressLower === zkSendAddress) {
      abiToUse = ZkSendABI;
    } else if (directSendAddress && contractAddressLower === directSendAddress) {
      abiToUse = DirectSendABI;
    } else {
    
    // Card creation functions are in the main GiftCard contract, not in Vault contracts
    const isCreateFunction = functionName.startsWith('createGiftCard');
    const isErc20Allowance = ERC20_ALLOWANCE_FUNCTION_NAMES.has(functionName);
    const isCircleBridgeKit =
      CIRCLE_BRIDGE_KIT_FUNCTION_NAMES.has(functionName) ||
      contractAddressLower === CIRCLE_BRIDGE_KIT_CONTRACT_LOWER;
    const isCctpV2Bridge = CCTP_V2_FUNCTION_NAMES.has(functionName);
    // Main GiftCard contract addresses
    const mainContractAddresses: string[] = [
      Deno.env.get('VITE_ARC_CONTRACT_ADDRESS'),
      Deno.env.get('VITE_CONTRACT_ADDRESS'),
      '0x5743fd9c6372bE37B2CE8884EA9e8bF291132677', // Current address from logs
      '0x7f5c9e8548002134cde6093f2ca3ff5b8bd26982' // Fallback address
    ].filter((addr): addr is string => Boolean(addr)).map(addr => addr.toLowerCase());
    const isMainContract = mainContractAddresses.some(addr => contractAddressLower === addr);
    
    if (isErc20Allowance) {
      abiToUse = ERC20_ALLOWANCE_ABI;
    } else if (isCircleBridgeKit) {
      abiToUse = CIRCLE_BRIDGE_KIT_ABI;
    } else if (isCctpV2Bridge) {
      abiToUse = CCTP_V2_BRIDGE_ABI;
    } else if (isCreateFunction || isMainContract) {
      // Use the main contract ABI for card creation functions
      abiToUse = GiftCardABI;
    } else {
      // Determine the Vault contract ABI by contract address or platform
      if (socialPlatform === 'twitter' || contractAddressLower.includes('twitter') || 
          contractAddressLower === '0xf8a0870530bb7cd1d658742a079f85e91dfc8e3c') {
        abiToUse = TwitterCardVaultABI;
      } else if (socialPlatform === 'telegram' || contractAddressLower.includes('telegram') ||
                 contractAddressLower === '0x619a49213860a0448736880c4f456bcdfb96d938') {
        abiToUse = TelegramCardVaultABI;
      } else if (socialPlatform === 'twitch' || contractAddressLower.includes('twitch') ||
                 contractAddressLower === '0xa27e6cef4e9d794ee0356461fe65437bb5f7cbe3') {
        abiToUse = TwitchCardVaultABI;
      }
    }
    }
    }

    let resolvedCallData: string | null =
      typeof callDataRaw === 'string' && callDataRaw.startsWith('0x') ? callDataRaw : null;

    if (
      !resolvedCallData &&
      functionName &&
      ZKSEND_CLAIM_FUNCTION_NAMES.has(functionName) &&
      Array.isArray(args)
    ) {
      const zkSendAddress = getZkSendContractAddressLower();
      if (zkSendAddress && contractAddressLower === zkSendAddress) {
        const encoded = encodeZkSendClaimCallData(functionName, args);
        if (!encoded.ok) {
          console.error('[send-transaction] ZkSend claim encode failed:', encoded.error);
          return c.json({
            success: false,
            error: 'Failed to encode claim calldata',
            details: encoded.error,
            code: 'CLAIM_ENCODE_FAILED',
          }, 400);
        }
        resolvedCallData = encoded.callData;
        console.log('[send-transaction] ZkSend claim encoded to callData', {
          functionName,
          mode: 'callData',
          encodeReason: 'zksend_claim_tuple',
          callDataPreview: `${resolvedCallData.slice(0, 18)}...`,
        });
      }
    }

    const useCallDataFinal =
      typeof resolvedCallData === 'string' && resolvedCallData.startsWith('0x');

    const transactionDataBase = {
      walletId: walletId as string,
      contractAddress: contractAddress as string,
      feeLevel: 'MEDIUM' as const,
      entitySecretCiphertext: entitySecretCiphertextForRequest,
      idempotencyKey: crypto.randomUUID(),
    };

    const transactionData = useCallDataFinal
      ? {
          ...transactionDataBase,
          callData: resolvedCallData as string,
        }
      : {
          ...transactionDataBase,
          abiFunctionSignature: getFunctionSignature(functionName as string, abiToUse) as string,
          abiParameters: (args as any[]).map((arg: any) => serializeCircleAbiArg(arg)),
        };

    console.log('Sending transaction to Circle API:', {
      walletId: transactionData.walletId,
      contractAddress: transactionData.contractAddress,
      mode: useCallDataFinal ? 'callData' : 'abi',
      abiFunctionSignature: 'abiFunctionSignature' in transactionData ? transactionData.abiFunctionSignature : undefined,
      abiParameters: 'abiParameters' in transactionData ? transactionData.abiParameters : undefined,
      callDataPreview: useCallDataFinal ? `${(resolvedCallData as string).slice(0, 18)}...` : undefined,
      feeLevel: transactionData.feeLevel,
      blockchain: blockchain,
      functionName: functionName ?? rawFunctionName,
    });

    // Optional wallet check in Circle (may not work if the wallet belongs to a different entity)
    // If the wallet exists in DB and is LIVE, try sending the transaction directly.
    // Circle API will error on creation if the wallet does not belong to the entity.
    let walletVerifiedInCircle = false;
    try {
      const walletCheckResponse = await fetch(`https://api.circle.com/v1/w3s/developer/wallets/${walletId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${circleApiKey}`,
          'Content-Type': 'application/json',
          'X-Entity-Secret-Ciphertext': entitySecretCiphertextForRequest
        }
      });

      if (walletCheckResponse.ok) {
        const walletData = await walletCheckResponse.json();
        console.log('Wallet verified in Circle:', {
          walletId: walletData.data?.wallet?.id,
          state: walletData.data?.wallet?.state,
          address: walletData.data?.wallet?.address,
          blockchain: walletData.data?.wallet?.blockchain
        });
        walletVerifiedInCircle = true;

        // Ensure the wallet is in the correct state
        if (walletData.data?.wallet?.state !== 'LIVE') {
          console.warn('Wallet is not in LIVE state:', walletData.data?.wallet?.state);
        }
      } else {
        // Wallet not found in Circle; this can be normal if it belongs to a different entity.
        // Continue and attempt to send the transaction - Circle will error if the wallet is not owned by the entity.
        const errorText = await walletCheckResponse.text();
        console.warn('Wallet check returned non-OK status (this may be normal if wallet belongs to different entity):', {
          status: walletCheckResponse.status,
          statusText: walletCheckResponse.statusText,
          error: errorText,
          walletId: walletId,
          note: 'Will attempt to send the transaction anyway - Circle API will return an error if wallet does not belong to the entity'
        });
      }
    } catch (walletCheckError) {
      // Error during wallet check - continue and attempt to send the transaction
      console.warn('Error checking wallet in Circle (will attempt the transaction anyway):', walletCheckError);
    }

    // Send the transaction via the Circle API
    // Use the correct endpoint for contract execution per documentation
    // https://developers.circle.com/api-reference/w3s/developer-controlled-wallets/create-contract-execution-transaction
    const usedEndpoint = `https://api.circle.com/v1/w3s/developer/transactions/contractExecution`;
    
    console.log('Sending contract execution request to Circle API:', {
      endpoint: usedEndpoint,
      walletId: transactionData.walletId,
      walletAddress: walletAddress,
      contractAddress: transactionData.contractAddress,
      mode: useCallDataFinal ? 'callData' : 'abi',
      abiFunctionSignature: 'abiFunctionSignature' in transactionData ? transactionData.abiFunctionSignature : undefined,
      abiParameters: 'abiParameters' in transactionData ? transactionData.abiParameters : undefined,
      callDataPreview: useCallDataFinal ? `${(resolvedCallData as string).slice(0, 18)}...` : undefined,
      feeLevel: transactionData.feeLevel,
      entitySecretCiphertext: transactionData.entitySecretCiphertext ? `${transactionData.entitySecretCiphertext.substring(0, 20)}...` : 'MISSING',
      blockchain: blockchain,
      walletVerifiedInCircle: walletVerifiedInCircle,
      walletStateInDB: wallet.state,
      note: walletVerifiedInCircle 
        ? 'Wallet verified in Circle - proceeding with transaction'
        : 'Wallet not verified in Circle (may belong to different entity) - attempting transaction anyway'
    });
    
    const response = await fetch(usedEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${circleApiKey}`,
        'Content-Type': 'application/json',
        'X-Entity-Secret-Ciphertext': entitySecretCiphertextForRequest
      },
      body: JSON.stringify(transactionData)
    });

    console.log('Circle API response status:', response.status, 'Endpoint used:', usedEndpoint);

    if (!response.ok) {
      let errorText: string;
      let errorJson: any = null;
      
      try {
        errorText = await response.text();
        // Try parse json
        try {
          errorJson = JSON.parse(errorText);
        } catch {
          // If not JSON, leave as text
        }
      } catch (e) {
        errorText = `Failed to read error response: ${e}`;
      }

      const errorDetails = {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
        errorJson: errorJson,
        endpoint: usedEndpoint,
        requestData: {
          walletId: transactionData.walletId,
          contractAddress: transactionData.contractAddress,
          mode: useCallDataFinal ? 'callData' : 'abi',
          feeLevel: transactionData.feeLevel,
        }
      };

      console.error('Circle API error response:', errorDetails);

      // Special handling for a 404 error
      if (response.status === 404) {
        return c.json({
          error: 'Resource not found',
          details: errorJson?.message || errorText || 'The requested resource was not found',
          possibleCauses: [
            'Wallet ID does not exist in Circle',
            'Wallet ID does not belong to your entity',
            'Contract address is invalid',
            'Incorrect API endpoint or method'
          ],
          errorResponse: errorJson || errorText,
          requestData: {
            walletId: transactionData.walletId,
            contractAddress: transactionData.contractAddress
          }
        }, 404);
      }

      return c.json({
        error: 'Circle API error',
        status: response.status,
        details: errorJson?.message || errorText || 'Unknown error',
        errorResponse: errorJson || errorText
      }, response.status);
    }

    const result = await response.json();
    console.log('Circle API transaction response:', JSON.stringify(result, null, 2));
    
    // Circle API returns a transaction id and state; txHash may be located elsewhere
    const transactionId: string | undefined = result.data?.id;
    let transactionState: string | undefined = result.data?.state;
    let txHash: string | undefined = result.data?.transaction?.hash || result.data?.hash;

    if (!transactionId) {
      console.error('No transaction ID in response:', result);
      throw new Error('Failed to get transaction ID from Circle API');
    }

    // Client polls `/wallets/transaction-status` - avoid blocking Edge on Circle confirmation.
    return c.json({
      success: true,
      txHash: txHash || undefined,
      transactionId: transactionId,
      transactionState: transactionState,
      transaction: result.data,
    });
  } catch (error) {
    console.error('Error sending transaction:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to send transaction',
      details: errorMessage
    }, 500);
  }
});

// Get transaction status by transactionId
app.get('/wallets/transaction-status', async (c) => {
  try {
    const transactionId = c.req.query('transactionId');
    
    if (!transactionId) {
      return c.json({ error: 'Missing transactionId parameter' }, 400);
    }

    const circleApiKey = Deno.env.get('CIRCLE_API_KEY');
    if (!circleApiKey) {
      return c.json({ error: 'Circle API key not configured' }, 500);
    }

    // Obtain the entity secret ciphertext
    let entitySecretCiphertextForRequest: string;
    const circleEntitySecretCiphertext = Deno.env.get('CIRCLE_ENTITY_SECRET_CIPHERTEXT');
    const circleEntitySecret = Deno.env.get('CIRCLE_ENTITY_SECRET');

    if (circleEntitySecretCiphertext) {
      entitySecretCiphertextForRequest = circleEntitySecretCiphertext;
    } else if (circleEntitySecret) {
      // If only the entity secret is available, we would need to fetch the public key and encrypt it.
      // For simplicity, require ciphertext here if available.
      return c.json({ error: 'Entity secret ciphertext required' }, 500);
    } else {
      return c.json({ error: 'Circle Entity Secret or Ciphertext required' }, 500);
    }

    // Try the common status endpoint (often responds right after INITIATED)
    const commonUrl = `https://api.circle.com/v1/w3s/transactions/${transactionId}`;
    const developerUrl = `https://api.circle.com/v1/w3s/developer/transactions/${transactionId}`;

    const baseHeaders: Record<string, string> = {
      'Authorization': `Bearer ${circleApiKey}`,
      'Content-Type': 'application/json'
    };
    const developerHeaders = {
      ...baseHeaders,
      'X-Entity-Secret-Ciphertext': entitySecretCiphertextForRequest
    };

    // 1) Try without /developer
    let response = await fetch(commonUrl, { method: 'GET', headers: baseHeaders });

    // 2) If it fails (e.g., 404/401), try /developer (for developer-controlled wallets)
    if (!response.ok) {
      response = await fetch(developerUrl, { method: 'GET', headers: developerHeaders });
    }

    if (!response.ok) {
      const errorText = await response.text();
      return c.json({
        error: 'Failed to get transaction status',
        details: errorText,
      }, response.status);
    }

    const result = await response.json();
    const transactionData = result.data?.transaction || result.data;

    const txHash =
      transactionData?.hash ||
      transactionData?.txHash ||
      transactionData?.transactionHash;
    const transactionState = transactionData?.state || result.data?.state;

    return c.json({
      success: true,
      txHash: txHash || undefined,
      transactionId,
      transactionState,
      transaction: transactionData
    });
  } catch (error) {
    console.error('Error getting transaction status:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'Failed to get transaction status',
      details: errorMessage
    }, 500);
  }
});

// Toggle favorite status for social contact
app.patch('/contacts/social/favorite', async (c) => {
  try {
    const { userId, platform, socialId, isFavorite } = await c.req.json();
    
    if (!userId || !platform || !socialId || typeof isFavorite !== 'boolean') {
      return c.json({ 
        error: 'Missing required fields',
        required: ['userId', 'platform', 'socialId', 'isFavorite']
      }, 400);
    }

    const client = getSupabaseClient();
    
    let tableName: string;
    let idColumn: string;
    
    switch (platform) {
      case 'twitch':
        tableName = 'twitch_followed';
        idColumn = 'broadcaster_id';
        break;
      case 'twitter':
        tableName = 'twitter_followed';
        idColumn = 'twitter_user_id';
        break;
      case 'tiktok':
        tableName = 'tiktok_followed';
        idColumn = 'tiktok_user_id';
        break;
      case 'instagram':
        tableName = 'instagram_followed';
        idColumn = 'instagram_user_id';
        break;
      case 'telegram':
        tableName = 'telegram_contacts';
        idColumn = 'telegram_user_id';
        break;
      default:
        return c.json({ 
          error: 'Unsupported platform',
          supported: ['twitch', 'twitter', 'tiktok', 'instagram', 'telegram']
        }, 400);
    }
    
    const { error } = await client
      .from(tableName)
      .update({ is_favorite: isFavorite })
      .eq('user_id', userId)
      .eq(idColumn, socialId);

    if (error) {
      console.error('[SOCIAL CONTACT] Error updating favorite:', error);
      return c.json({ 
        error: 'Failed to update favorite status',
        details: error.message 
      }, 500);
    }

    return c.json({
      success: true,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[SOCIAL CONTACT] Unexpected error:', errorMessage);
    return c.json({ 
      error: 'Internal server error',
      details: errorMessage 
    }, 500);
  }
});

// ------------------------------
// Agent schedule helpers
// ------------------------------

interface SchedulePayload {
  userId: string;
  name: string;
  description?: string | null;
  sourceType: string;
  sourceConfig?: Record<string, unknown>;
  tokenSymbol?: string;
  tokenAddress?: string | null;
  network?: string;
  amountType?: string;
  amountValue: number | string;
  amountField?: string | null;
  currency?: string;
  scheduleType?: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  timeOfDay?: string | null;
  timezone?: string | null;
  cronExpression?: string | null;
  startAt?: string;
  endAt?: string | null;
  maxRuns?: number | null;
  skipStrategy?: string;
  metadata?: Record<string, unknown>;
  status?: string;
  paused?: boolean;
}

interface ScheduleRecord {
  id?: string;
  user_id: string;
  name: string;
  description: string | null;
  source_type: string;
  source_config: Record<string, unknown>;
  token_symbol: string;
  token_address: string | null;
  network: string;
  amount_type: string;
  amount_value: string;
  amount_field: string | null;
  currency: string;
  schedule_type: string;
  day_of_week: number | null;
  day_of_month: number | null;
  time_of_day: string;
  timezone: string;
  cron_expression: string | null;
  start_at: string;
  end_at: string | null;
  max_runs: number | null;
  status: string;
  paused: boolean;
  skip_strategy: string;
  last_run_at: string | null;
  next_run_at: string | null;
  total_runs: number;
  total_failures: number;
  total_amount: string;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface JobExecutionRecord {
  id: string;
  schedule_id: string;
  user_id: string;
  status: string;
  run_type: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  total_recipients: number;
  success_count: number;
  failure_count: number;
  total_amount: string;
  amount_currency: string;
  error_message: string | null;
  details: unknown;
  payload_snapshot: unknown;
  result: unknown;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const ALLOWED_SOURCE_TYPES = new Set(['personal_contacts', 'twitch_table', 'manual', 'import']);
const ALLOWED_AMOUNT_TYPES = new Set(['fixed', 'percentage', 'formula']);
const ALLOWED_SCHEDULE_TYPES = new Set(['daily', 'weekly', 'monthly', 'custom']);
const ALLOWED_SKIP_STRATEGIES = new Set(['catch_up', 'skip', 'manual']);
const ALLOWED_STATUSES = new Set(['active', 'paused', 'completed', 'cancelled', 'draft']);

function ensureTimeOfDay(time?: string | null): string {
  if (!time || typeof time !== 'string') {
    return '09:00:00';
  }

  const trimmed = time.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return '09:00:00';
  }

  const hours = Math.min(Math.max(parseInt(match[1], 10) || 0, 0), 23);
  const minutes = Math.min(Math.max(parseInt(match[2], 10) || 0, 0), 59);
  const seconds = Math.min(Math.max(parseInt(match[3] ?? '0', 10) || 0, 0), 59);

  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    seconds.toString().padStart(2, '0'),
  ].join(':');
}

function parseIntegerField(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'string' ? parseInt(value, 10) : typeof value === 'number' ? Math.trunc(value) : NaN;
  return Number.isFinite(num) ? num : null;
}

function parseNumberAsString(value: unknown, fallback = '0'): string {
  if (value === null || value === undefined) return fallback;
  const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return num.toString();
}

function getNormalizedUserId(rawUserId: string | null | undefined): string | null {
  if (!rawUserId || typeof rawUserId !== 'string') {
    return null;
  }

  const normalizedWallet = normalizeWalletAddress(rawUserId);
  if (normalizedWallet) {
    return normalizedWallet;
  }

  return rawUserId.trim().toLowerCase();
}

function calculateNextRunAtFromRecord(
  record: Partial<ScheduleRecord> & { total_runs?: number },
  referenceDate?: Date
): string | null {
  if (!record) {
    return null;
  }

  const status = record.status ? record.status.toLowerCase() : 'active';

  if (record.paused || status === 'paused' || status === 'cancelled' || status === 'completed') {
    return null;
  }

  const maxRuns = typeof record.max_runs === 'number' ? record.max_runs : null;
  const totalRuns = typeof record.total_runs === 'number' ? record.total_runs : 0;
  if (maxRuns !== null && totalRuns >= maxRuns) {
    return null;
  }

  const startAt = record.start_at ? new Date(record.start_at) : new Date();
  if (Number.isNaN(startAt.getTime())) {
    return null;
  }

  const endAt = record.end_at ? new Date(record.end_at) : null;
  const reference = referenceDate ? new Date(referenceDate) : new Date();
  const effectiveReference = reference < startAt ? new Date(startAt) : reference;

  const timeString = ensureTimeOfDay(record.time_of_day);
  const [hours, minutes, seconds] = timeString.split(':').map((part) => parseInt(part, 10) || 0);

  const scheduleType = (record.schedule_type || 'weekly').toLowerCase();

  let candidate: Date;

  if (scheduleType === 'daily') {
    candidate = new Date(Date.UTC(
      effectiveReference.getUTCFullYear(),
      effectiveReference.getUTCMonth(),
      effectiveReference.getUTCDate(),
      hours,
      minutes,
      seconds,
    ));

    if (candidate <= effectiveReference) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
  } else if (scheduleType === 'weekly') {
    const targetDow = typeof record.day_of_week === 'number'
      ? Math.max(0, Math.min(6, record.day_of_week))
      : startAt.getUTCDay();

    candidate = new Date(Date.UTC(
      effectiveReference.getUTCFullYear(),
      effectiveReference.getUTCMonth(),
      effectiveReference.getUTCDate(),
      hours,
      minutes,
      seconds,
    ));

    const currentDow = candidate.getUTCDay();
    let diff = targetDow - currentDow;
    if (diff < 0 || (diff === 0 && candidate <= effectiveReference)) {
      diff += 7;
    }
    candidate.setUTCDate(candidate.getUTCDate() + diff);
  } else if (scheduleType === 'monthly') {
    const targetDom = typeof record.day_of_month === 'number'
      ? Math.max(1, Math.min(31, record.day_of_month))
      : startAt.getUTCDate();

    const year = effectiveReference.getUTCFullYear();
    const month = effectiveReference.getUTCMonth();

    candidate = new Date(Date.UTC(year, month, targetDom, hours, minutes, seconds, 0));

    if (candidate <= effectiveReference) {
      const nextMonth = new Date(Date.UTC(year, month + 1, 1, hours, minutes, seconds, 0));
      const daysInMonth = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0)).getUTCDate();
      const clampedDom = Math.min(targetDom, daysInMonth);
      candidate = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), clampedDom, hours, minutes, seconds, 0));
    }
  } else if (scheduleType === 'custom') {
    const nextRun = record.next_run_at ? new Date(record.next_run_at) : startAt;
    if (Number.isNaN(nextRun.getTime())) {
      return null;
    }
    if (nextRun <= effectiveReference) {
      return null;
    }
    candidate = nextRun;
  } else {
    candidate = new Date(startAt);
  }

  if (candidate < startAt) {
    candidate = new Date(startAt);
  }

  if (endAt && candidate > endAt) {
    return null;
  }

  return candidate.toISOString();
}

async function fetchScheduleById(client: any, scheduleId: string, userId: string): Promise<ScheduleRecord | null> {
  const { data, error } = await client
    .from('scheduled_jobs')
    .select('*')
    .eq('id', scheduleId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[SCHEDULE] Error fetching schedule by id:', error);
    throw new Error(error.message);
  }

  return data as ScheduleRecord | null;
}

function buildScheduleRecord(payload: SchedulePayload): ScheduleRecord {
  const normalizedUserId = getNormalizedUserId(payload.userId);
  if (!normalizedUserId) {
    throw new Error('Invalid userId');
  }

  if (!payload.name || typeof payload.name !== 'string') {
    throw new Error('Schedule name is required');
  }

  if (!payload.sourceType || !ALLOWED_SOURCE_TYPES.has(payload.sourceType)) {
    throw new Error(`Unsupported sourceType. Allowed: ${Array.from(ALLOWED_SOURCE_TYPES).join(', ')}`);
  }

  const scheduleType = (payload.scheduleType || 'weekly').toLowerCase();
  if (!ALLOWED_SCHEDULE_TYPES.has(scheduleType)) {
    throw new Error(`Unsupported scheduleType. Allowed: ${Array.from(ALLOWED_SCHEDULE_TYPES).join(', ')}`);
  }

  if (scheduleType === 'custom' && !payload.cronExpression) {
    throw new Error('cronExpression is required for custom schedules');
  }

  const amountType = (payload.amountType || 'fixed').toLowerCase();
  if (!ALLOWED_AMOUNT_TYPES.has(amountType)) {
    throw new Error(`Unsupported amountType. Allowed: ${Array.from(ALLOWED_AMOUNT_TYPES).join(', ')}`);
  }

  const skipStrategy = (payload.skipStrategy || 'catch_up').toLowerCase();
  if (!ALLOWED_SKIP_STRATEGIES.has(skipStrategy)) {
    throw new Error(`Unsupported skipStrategy. Allowed: ${Array.from(ALLOWED_SKIP_STRATEGIES).join(', ')}`);
  }

  const desiredStatus = payload.status ? payload.status.toLowerCase() : 'active';
  if (!ALLOWED_STATUSES.has(desiredStatus)) {
    throw new Error(`Unsupported status. Allowed: ${Array.from(ALLOWED_STATUSES).join(', ')}`);
  }

  const startAtRaw = payload.startAt ? new Date(payload.startAt) : new Date();
  if (Number.isNaN(startAtRaw.getTime())) {
    throw new Error('Invalid startAt value');
  }

  const endAtRaw = payload.endAt ? new Date(payload.endAt) : null;
  if (endAtRaw && Number.isNaN(endAtRaw.getTime())) {
    throw new Error('Invalid endAt value');
  }

  if (endAtRaw && endAtRaw <= startAtRaw) {
    throw new Error('endAt must be after startAt');
  }

  const timeOfDay = ensureTimeOfDay(payload.timeOfDay || payload.startAt);

  const baseRecord: ScheduleRecord = {
    user_id: normalizedUserId,
    name: payload.name.trim(),
    description: payload.description ? String(payload.description).trim() : null,
    source_type: payload.sourceType,
    source_config: payload.sourceConfig || {},
    token_symbol: payload.tokenSymbol || 'USDC',
    token_address: payload.tokenAddress || null,
    network: payload.network || 'ARC-TESTNET',
    amount_type: amountType,
    amount_value: parseNumberAsString(payload.amountValue, '0'),
    amount_field: payload.amountField || null,
    currency: payload.currency || 'USDC',
    schedule_type: scheduleType,
    day_of_week: scheduleType === 'weekly' ? parseIntegerField(payload.dayOfWeek) ?? startAtRaw.getUTCDay() : parseIntegerField(payload.dayOfWeek),
    day_of_month: scheduleType === 'monthly' ? parseIntegerField(payload.dayOfMonth) ?? startAtRaw.getUTCDate() : parseIntegerField(payload.dayOfMonth),
    time_of_day: timeOfDay,
    timezone: payload.timezone || 'UTC',
    cron_expression: payload.cronExpression || null,
    start_at: startAtRaw.toISOString(),
    end_at: endAtRaw ? endAtRaw.toISOString() : null,
    max_runs: parseIntegerField(payload.maxRuns) ?? null,
    status: desiredStatus,
    paused: Boolean(payload.paused),
    skip_strategy: skipStrategy,
    last_run_at: null,
    next_run_at: null,
    total_runs: 0,
    total_failures: 0,
    total_amount: '0',
    metadata: payload.metadata || {},
  };

  const nextRun = calculateNextRunAtFromRecord(baseRecord, new Date());
  baseRecord.next_run_at = nextRun || baseRecord.start_at;

  return baseRecord;
}

function mergeScheduleUpdates(existing: ScheduleRecord, updates: Partial<SchedulePayload>): ScheduleRecord {
  const merged: ScheduleRecord = {
    ...existing,
    name: updates.name ? updates.name.trim() : existing.name,
    description: updates.description !== undefined ? (updates.description ? String(updates.description).trim() : null) : existing.description,
    source_type: updates.sourceType && ALLOWED_SOURCE_TYPES.has(updates.sourceType) ? updates.sourceType : existing.source_type,
    source_config: updates.sourceConfig ? updates.sourceConfig : existing.source_config,
    token_symbol: updates.tokenSymbol || existing.token_symbol,
    token_address: updates.tokenAddress !== undefined ? updates.tokenAddress : existing.token_address,
    network: updates.network || existing.network,
    amount_type: updates.amountType && ALLOWED_AMOUNT_TYPES.has(updates.amountType) ? updates.amountType : existing.amount_type,
    amount_value: updates.amountValue !== undefined ? parseNumberAsString(updates.amountValue, existing.amount_value) : existing.amount_value,
    amount_field: updates.amountField !== undefined ? updates.amountField : existing.amount_field,
    currency: updates.currency || existing.currency,
    schedule_type: updates.scheduleType && ALLOWED_SCHEDULE_TYPES.has(updates.scheduleType) ? updates.scheduleType : existing.schedule_type,
    day_of_week: updates.dayOfWeek !== undefined ? parseIntegerField(updates.dayOfWeek) : existing.day_of_week,
    day_of_month: updates.dayOfMonth !== undefined ? parseIntegerField(updates.dayOfMonth) : existing.day_of_month,
    time_of_day: updates.timeOfDay !== undefined ? ensureTimeOfDay(updates.timeOfDay) : existing.time_of_day,
    timezone: updates.timezone || existing.timezone,
    cron_expression: updates.cronExpression !== undefined ? updates.cronExpression : existing.cron_expression,
    skip_strategy: updates.skipStrategy && ALLOWED_SKIP_STRATEGIES.has(updates.skipStrategy) ? updates.skipStrategy : existing.skip_strategy,
    metadata: updates.metadata ? { ...existing.metadata, ...updates.metadata } : existing.metadata,
    status: updates.status && ALLOWED_STATUSES.has(updates.status) ? updates.status : existing.status,
    paused: typeof updates.paused === 'boolean' ? updates.paused : existing.paused,
  };

  if (updates.startAt) {
    const startAtDate = new Date(updates.startAt);
    if (Number.isNaN(startAtDate.getTime())) {
      throw new Error('Invalid startAt value');
    }
    merged.start_at = startAtDate.toISOString();
  }

  if (updates.endAt !== undefined) {
    if (updates.endAt === null) {
      merged.end_at = null;
    } else {
      const endAtDate = new Date(updates.endAt);
      if (Number.isNaN(endAtDate.getTime())) {
        throw new Error('Invalid endAt value');
      }
      merged.end_at = endAtDate.toISOString();
    }
  }

  if (updates.maxRuns !== undefined) {
    merged.max_runs = parseIntegerField(updates.maxRuns);
  }

  if (updates.scheduleType && updates.scheduleType.toLowerCase() === 'custom' && !merged.cron_expression) {
    throw new Error('cronExpression is required for custom schedules');
  }

  return merged;
}

async function enrichSchedulesWithExecutions(client: any, schedules: ScheduleRecord[]): Promise<Array<ScheduleRecord & { last_execution: JobExecutionRecord | null }>> {
  if (!schedules || schedules.length === 0) {
    return [];
  }

  const scheduleIds = schedules.map((schedule) => schedule.id).filter(Boolean);
  if (scheduleIds.length === 0) {
    return schedules.map((schedule) => ({ ...schedule, last_execution: null }));
  }

  const { data: executionRows, error: execError } = await client
    .from('job_executions')
    .select('id,schedule_id,user_id,status,run_type,queued_at,started_at,finished_at,total_recipients,success_count,failure_count,total_amount,amount_currency,error_message,details,payload_snapshot,result,metadata,created_at,updated_at')
    .in('schedule_id', scheduleIds)
    .order('queued_at', { ascending: false })
    .limit(scheduleIds.length * 5);

  if (execError) {
    console.error('[SCHEDULE] Error loading executions:', execError);
    throw new Error(execError.message);
  }

  const executionMap = new Map<string, JobExecutionRecord>();
  if (executionRows) {
    for (const execution of executionRows as JobExecutionRecord[]) {
      if (!executionMap.has(execution.schedule_id)) {
        executionMap.set(execution.schedule_id, execution);
      }
    }
  }

  return schedules.map((schedule) => ({
    ...schedule,
    last_execution: executionMap.get(schedule.id || '') || null,
  }));
}

// ------------------------------
// Agent schedule endpoints
// ------------------------------

app.get('/agent/schedules', async (c) => {
  try {
    const userIdParam = c.req.query('userId');
    const normalizedUserId = getNormalizedUserId(userIdParam || '');

    if (!normalizedUserId) {
      return c.json({ error: 'Missing or invalid userId query parameter' }, 400);
    }

    const statusFilter = c.req.query('status');
    const includeHistory = c.req.query('includeHistory') === 'true';

    const client = getSupabaseClient();

    let query = client
      .from('scheduled_jobs')
      .select('*')
      .eq('user_id', normalizedUserId)
      .order('created_at', { ascending: false });

    if (statusFilter && ALLOWED_STATUSES.has(statusFilter)) {
      query = query.eq('status', statusFilter);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[SCHEDULE] Error fetching schedules:', error);
      return c.json({ error: 'Failed to fetch schedules', details: error.message }, 500);
    }

    const schedules = Array.isArray(data) ? (data as ScheduleRecord[]) : [];
    const recordsWithNextRun = schedules.map((schedule) => {
      const nextRun = calculateNextRunAtFromRecord(schedule, new Date());
      return {
        ...schedule,
        next_run_at: nextRun,
      };
    });

    const enriched = includeHistory
      ? await enrichSchedulesWithExecutions(client, recordsWithNextRun)
      : recordsWithNextRun.map((schedule) => ({ ...schedule, last_execution: null }));

    return c.json({
      success: true,
      data: enriched,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[SCHEDULE] Unexpected error listing schedules:', error);
    return c.json({ error: 'Internal server error', details: errorMessage }, 500);
  }
});

app.post('/agent/schedules', async (c) => {
  try {
    const rawPayload = await c.req.json().catch(() => null);

    if (!rawPayload || typeof rawPayload !== 'object') {
      return c.json({ error: 'Invalid payload' }, 400);
    }

    const payload = rawPayload as SchedulePayload;

    const record = buildScheduleRecord(payload);
    const client = getSupabaseClient();

    const { data, error } = await client
      .from('scheduled_jobs')
      .insert(record)
      .select()
      .maybeSingle();

    if (error) {
      console.error('[SCHEDULE] Error inserting schedule:', error);
      return c.json({ error: 'Failed to create schedule', details: error.message }, 500);
    }

    const created = data as ScheduleRecord;
    const nextRun = calculateNextRunAtFromRecord(created, new Date());

    if (nextRun !== created.next_run_at) {
      await client
        .from('scheduled_jobs')
        .update({ next_run_at: nextRun })
        .eq('id', created.id);
      created.next_run_at = nextRun;
    }

    return c.json({
      success: true,
      data: created,
    }, 201);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[SCHEDULE] Unexpected error creating schedule:', error);
    return c.json({ error: 'Internal server error', details: errorMessage }, 500);
  }
});

app.get('/agent/schedules/:id', async (c) => {
  try {
    const scheduleId = c.req.param('id');
    const userIdParam = c.req.query('userId');
    const normalizedUserId = getNormalizedUserId(userIdParam || '');

    if (!scheduleId) {
      return c.json({ error: 'Missing schedule id' }, 400);
    }

    if (!normalizedUserId) {
      return c.json({ error: 'Missing or invalid userId query parameter' }, 400);
    }

    const client = getSupabaseClient();

    const schedule = await fetchScheduleById(client, scheduleId, normalizedUserId);
    if (!schedule) {
      return c.json({ error: 'Schedule not found' }, 404);
    }

    const nextRun = calculateNextRunAtFromRecord(schedule, new Date());
    schedule.next_run_at = nextRun;

    const limitParam = parseIntegerField(c.req.query('limit')) || 20;

    const { data: executions, error: execError } = await client
      .from('job_executions')
      .select('id,schedule_id,user_id,status,run_type,queued_at,started_at,finished_at,total_recipients,success_count,failure_count,total_amount,amount_currency,error_message,details,payload_snapshot,result,metadata,created_at,updated_at')
      .eq('schedule_id', scheduleId)
      .eq('user_id', normalizedUserId)
      .order('queued_at', { ascending: false })
      .limit(Math.min(100, Math.max(1, limitParam)));

    if (execError) {
      console.error('[SCHEDULE] Error fetching executions:', execError);
      return c.json({ error: 'Failed to fetch executions', details: execError.message }, 500);
    }

    return c.json({
      success: true,
      data: {
        schedule,
        executions: executions || [],
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[SCHEDULE] Unexpected error fetching schedule:', error);
    return c.json({ error: 'Internal server error', details: errorMessage }, 500);
  }
});

app.get('/agent/schedules/:id/executions', async (c) => {
  try {
    const scheduleId = c.req.param('id');
    const userIdParam = c.req.query('userId');
    const normalizedUserId = getNormalizedUserId(userIdParam || '');
    const page = parseIntegerField(c.req.query('page')) || 1;
    const pageSize = parseIntegerField(c.req.query('pageSize')) || 20;

    if (!scheduleId) {
      return c.json({ error: 'Missing schedule id' }, 400);
    }

    if (!normalizedUserId) {
      return c.json({ error: 'Missing or invalid userId query parameter' }, 400);
    }

    const limit = Math.min(100, Math.max(1, pageSize));
    const offset = Math.max(0, (page - 1) * limit);

    const client = getSupabaseClient();

    const { data, error, count } = await client
      .from('job_executions')
      .select('id,schedule_id,user_id,status,run_type,queued_at,started_at,finished_at,total_recipients,success_count,failure_count,total_amount,amount_currency,error_message,details,payload_snapshot,result,metadata,created_at,updated_at', { count: 'exact' })
      .eq('schedule_id', scheduleId)
      .eq('user_id', normalizedUserId)
      .order('queued_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('[SCHEDULE] Error fetching executions list:', error);
      return c.json({ error: 'Failed to fetch executions', details: error.message }, 500);
    }

    return c.json({
      success: true,
      data: data || [],
      pagination: {
        page,
        pageSize: limit,
        total: count ?? 0,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[SCHEDULE] Unexpected error listing executions:', error);
    return c.json({ error: 'Internal server error', details: errorMessage }, 500);
  }
});

app.patch('/agent/schedules/:id', async (c) => {
  try {
    const scheduleId = c.req.param('id');
    const rawPayload = await c.req.json().catch(() => null);

    if (!scheduleId) {
      return c.json({ error: 'Missing schedule id' }, 400);
    }

    if (!rawPayload || typeof rawPayload !== 'object') {
      return c.json({ error: 'Invalid payload' }, 400);
    }

    const payload = rawPayload as Partial<SchedulePayload>;

    const normalizedUserId = getNormalizedUserId(payload.userId || (payload as any).user_id);
    if (!normalizedUserId) {
      return c.json({ error: 'Missing or invalid userId' }, 400);
    }

    const client = getSupabaseClient();

    const existing = await fetchScheduleById(client, scheduleId, normalizedUserId);
    if (!existing) {
      return c.json({ error: 'Schedule not found' }, 404);
    }

    const merged = mergeScheduleUpdates(existing, payload);
    const nextRun = calculateNextRunAtFromRecord(merged, new Date());
    merged.next_run_at = nextRun;

    const { data, error } = await client
      .from('scheduled_jobs')
      .update({
        name: merged.name,
        description: merged.description,
        source_type: merged.source_type,
        source_config: merged.source_config,
        token_symbol: merged.token_symbol,
        token_address: merged.token_address,
        network: merged.network,
        amount_type: merged.amount_type,
        amount_value: merged.amount_value,
        amount_field: merged.amount_field,
        currency: merged.currency,
        schedule_type: merged.schedule_type,
        day_of_week: merged.day_of_week,
        day_of_month: merged.day_of_month,
        time_of_day: merged.time_of_day,
        timezone: merged.timezone,
        cron_expression: merged.cron_expression,
        start_at: merged.start_at,
        end_at: merged.end_at,
        max_runs: merged.max_runs,
        skip_strategy: merged.skip_strategy,
        metadata: merged.metadata,
        next_run_at: merged.next_run_at,
        status: merged.status,
        paused: merged.paused,
      })
      .eq('id', scheduleId)
      .eq('user_id', normalizedUserId)
      .select()
      .maybeSingle();

    if (error) {
      console.error('[SCHEDULE] Error updating schedule:', error);
      return c.json({ error: 'Failed to update schedule', details: error.message }, 500);
    }

    return c.json({
      success: true,
      data: data,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[SCHEDULE] Unexpected error updating schedule:', error);
    return c.json({ error: 'Internal server error', details: errorMessage }, 500);
  }
});

app.delete('/agent/schedules/:id', async (c) => {
  try {
    const scheduleId = c.req.param('id');
    const payload = await c.req.json().catch(() => ({})) as { userId?: string };
    const userIdParam = c.req.query('userId');

    if (!scheduleId) {
      return c.json({ error: 'Missing schedule id' }, 400);
    }

    const normalizedUserId = getNormalizedUserId(payload.userId || userIdParam || '');
    if (!normalizedUserId) {
      return c.json({ error: 'Missing or invalid userId' }, 400);
    }

    const client = getSupabaseClient();

    const existing = await fetchScheduleById(client, scheduleId, normalizedUserId);
    if (!existing) {
      return c.json({ error: 'Schedule not found' }, 404);
    }

    const { error } = await client
      .from('scheduled_jobs')
      .delete()
      .eq('id', scheduleId)
      .eq('user_id', normalizedUserId);

    if (error) {
      console.error('[SCHEDULE] Error deleting schedule:', error);
      return c.json({ error: 'Failed to delete schedule', details: error.message }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[SCHEDULE] Unexpected error deleting schedule:', error);
    return c.json({ error: 'Internal server error', details: errorMessage }, 500);
  }
});

app.post('/agent/schedules/:id/run', async (c) => {
  try {
    const scheduleId = c.req.param('id');
    const payload = await c.req.json().catch(() => ({})) as { userId?: string; metadata?: Record<string, unknown>; note?: string };
    const userIdParam = c.req.query('userId');

    if (!scheduleId) {
      return c.json({ error: 'Missing schedule id' }, 400);
    }

    const normalizedUserId = getNormalizedUserId(payload.userId || userIdParam || '');
    if (!normalizedUserId) {
      return c.json({ error: 'Missing or invalid userId' }, 400);
    }

    const client = getSupabaseClient();
    const schedule = await fetchScheduleById(client, scheduleId, normalizedUserId);

    if (!schedule) {
      return c.json({ error: 'Schedule not found' }, 404);
    }

    const now = new Date();
    const nextRun = calculateNextRunAtFromRecord(schedule, now);

    const executionPayload = {
      schedule_id: scheduleId,
      user_id: normalizedUserId,
      status: 'pending',
      run_type: 'manual',
      queued_at: now.toISOString(),
      total_recipients: 0,
      success_count: 0,
      failure_count: 0,
      total_amount: '0',
      amount_currency: schedule.currency,
      error_message: null,
      details: [],
      payload_snapshot: {
        schedule,
        trigger_note: payload.note || null,
      },
      metadata: {
        ...schedule.metadata,
        ...payload.metadata,
        triggered_at: now.toISOString(),
      },
    };

    const { data: insertedExecution, error: insertError } = await client
      .from('job_executions')
      .insert(executionPayload)
      .select()
      .maybeSingle();

    if (insertError) {
      console.error('[SCHEDULE] Error enqueuing manual run:', insertError);
      return c.json({ error: 'Failed to enqueue manual run', details: insertError.message }, 500);
    }

    // Update schedule next run (preview) without altering totals yet
    if (nextRun) {
      const nextAfterManual = calculateNextRunAtFromRecord(
        {
          ...schedule,
          next_run_at: nextRun,
        },
        new Date(now.getTime() + 60_000)
      );

      await client
        .from('scheduled_jobs')
        .update({
          next_run_at: nextAfterManual || nextRun,
          last_run_at: schedule.last_run_at,
        })
        .eq('id', scheduleId);
    }

    return c.json({
      success: true,
      data: insertedExecution,
      message: 'Manual run queued. Worker will process it asynchronously.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[SCHEDULE] Unexpected error enqueuing manual run:', error);
    return c.json({ error: 'Internal server error', details: errorMessage }, 500);
  }
});

// The Graph API configuration per chain
const THE_GRAPH_API_KEY = Deno.env.get('THE_GRAPH_API_KEY');
const GRAPH_URLS: Record<number, string> = {
  5042002: 'https://api.studio.thegraph.com/query/1715476/sendly/version/latest',
  43113: Deno.env.get('AVAX_GRAPH_URL') || '',
  84532: Deno.env.get('BASE_GRAPH_URL') || '',
};

/**
 * Query The Graph API for the given chain
 */
async function queryTheGraph(query: string, variables: Record<string, any> = {}, chainId: number = 5042002) {
  const url = GRAPH_URLS[chainId] || GRAPH_URLS[5042002];
  if (!url) {
    return {};
  }
  if (!THE_GRAPH_API_KEY) {
    console.error('[TheGraph] THE_GRAPH_API_KEY is not set');
    return {};
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${THE_GRAPH_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const result = await response.json();

  if (result.errors) {
    console.error('GraphQL errors:', result.errors);
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
}

/**
 * Get token symbol from address
 */
function getTokenSymbol(tokenAddress: string): 'USDC' | 'EURC' {
  const USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
  const EURC_ADDRESS = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
  
  const normalizedAddress = tokenAddress.toLowerCase();
  if (normalizedAddress === USDC_ADDRESS.toLowerCase()) {
    return 'USDC';
  } else if (normalizedAddress === EURC_ADDRESS.toLowerCase()) {
    return 'EURC';
  }
  
  return 'USDC';
}

/**
 * Sync gift cards from The Graph to Supabase
 */
app.post('/graph/sync-gift-cards', async (c) => {
  try {
    const client = getSupabaseClient();
    const body = await c.req.json().catch(() => ({}));
    const { limit = 1000 } = body;
    const chainId = getChainIdFromRequest(c.req.query(), body);
    const batchSize = 100;
    let totalSynced = 0;
    const errors: string[] = [];

    // Fetch all gift card created events using blockTimestamp-based pagination
    // Use two queries: one without filter for first batch, one with filter for subsequent batches
    const createdQueryFirst = `
      query GetGiftCardCreatedEvents($first: Int!) {
        giftCardCreateds(
          first: $first
          orderBy: blockTimestamp
          orderDirection: desc
        ) {
          id
          tokenId
          recipient
          amount
          token
          uri
          message
          blockNumber
          blockTimestamp
          transactionHash
        }
      }
    `;
    const createdQuery = `
      query GetGiftCardCreatedEvents($first: Int!, $blockTimestamp: BigInt!) {
        giftCardCreateds(
          first: $first
          orderBy: blockTimestamp
          orderDirection: desc
          where: { blockTimestamp_lt: $blockTimestamp }
        ) {
          id
          tokenId
          recipient
          amount
          token
          uri
          message
          blockNumber
          blockTimestamp
          transactionHash
        }
      }
    `;

    // Fetch all gift card redeemed events using blockTimestamp-based pagination
    const redeemedQueryFirst = `
      query GetGiftCardRedeemedEvents($first: Int!) {
        giftCardRedeemeds(
          first: $first
          orderBy: blockTimestamp
          orderDirection: desc
        ) {
          id
          tokenId
          redeemer
          amount
          token
          blockNumber
          blockTimestamp
          transactionHash
        }
      }
    `;
    const redeemedQuery = `
      query GetGiftCardRedeemedEvents($first: Int!, $blockTimestamp: BigInt!) {
        giftCardRedeemeds(
          first: $first
          orderBy: blockTimestamp
          orderDirection: desc
          where: { blockTimestamp_lt: $blockTimestamp }
        ) {
          id
          tokenId
          redeemer
          amount
          token
          blockNumber
          blockTimestamp
          transactionHash
        }
      }
    `;

    // Fetch social gift card events
    const socialQueries = [
      {
        name: 'giftCardCreatedForTwitters',
        type: 'twitter' as const,
        queryFirst: `
          query GetTwitterGiftCards($first: Int!) {
            giftCardCreatedForTwitters(
              first: $first
              orderBy: blockTimestamp
              orderDirection: desc
            ) {
              id
              tokenId
              username
              sender
              amount
              token
              uri
              message
              blockNumber
              blockTimestamp
              transactionHash
            }
          }
        `,
        query: `
          query GetTwitterGiftCards($first: Int!, $blockTimestamp: BigInt!) {
            giftCardCreatedForTwitters(
              first: $first
              orderBy: blockTimestamp
              orderDirection: desc
              where: { blockTimestamp_lt: $blockTimestamp }
            ) {
              id
              tokenId
              username
              sender
              amount
              token
              uri
              message
              blockNumber
              blockTimestamp
              transactionHash
            }
          }
        `
      },
      {
        name: 'giftCardCreatedForTwitches',
        type: 'twitch' as const,
        queryFirst: `
          query GetTwitchGiftCards($first: Int!) {
            giftCardCreatedForTwitches(
              first: $first
              orderBy: blockTimestamp
              orderDirection: desc
            ) {
              id
              tokenId
              username
              sender
              amount
              token
              uri
              message
              blockNumber
              blockTimestamp
              transactionHash
            }
          }
        `,
        query: `
          query GetTwitchGiftCards($first: Int!, $blockTimestamp: BigInt!) {
            giftCardCreatedForTwitches(
              first: $first
              orderBy: blockTimestamp
              orderDirection: desc
              where: { blockTimestamp_lt: $blockTimestamp }
            ) {
              id
              tokenId
              username
              sender
              amount
              token
              uri
              message
              blockNumber
              blockTimestamp
              transactionHash
            }
          }
        `
      },
      {
        name: 'giftCardCreatedForTelegrams',
        type: 'telegram' as const,
        queryFirst: `
          query GetTelegramGiftCards($first: Int!) {
            giftCardCreatedForTelegrams(
              first: $first
              orderBy: blockTimestamp
              orderDirection: desc
            ) {
              id
              tokenId
              username
              sender
              amount
              token
              uri
              message
              blockNumber
              blockTimestamp
              transactionHash
            }
          }
        `,
        query: `
          query GetTelegramGiftCards($first: Int!, $blockTimestamp: BigInt!) {
            giftCardCreatedForTelegrams(
              first: $first
              orderBy: blockTimestamp
              orderDirection: desc
              where: { blockTimestamp_lt: $blockTimestamp }
            ) {
              id
              tokenId
              username
              sender
              amount
              token
              uri
              message
              blockNumber
              blockTimestamp
              transactionHash
            }
          }
        `
      },
      {
        name: 'giftCardCreatedForTikToks',
        type: 'tiktok' as const,
        queryFirst: `
          query GetTikTokGiftCards($first: Int!) {
            giftCardCreatedForTikToks(
              first: $first
              orderBy: blockTimestamp
              orderDirection: desc
            ) {
              id
              tokenId
              username
              sender
              amount
              token
              uri
              message
              blockNumber
              blockTimestamp
              transactionHash
            }
          }
        `,
        query: `
          query GetTikTokGiftCards($first: Int!, $blockTimestamp: BigInt!) {
            giftCardCreatedForTikToks(
              first: $first
              orderBy: blockTimestamp
              orderDirection: desc
              where: { blockTimestamp_lt: $blockTimestamp }
            ) {
              id
              tokenId
              username
              sender
              amount
              token
              uri
              message
              blockNumber
              blockTimestamp
              transactionHash
            }
          }
        `
      },
      {
        name: 'giftCardCreatedForInstagrams',
        type: 'instagram' as const,
        queryFirst: `
          query GetInstagramGiftCards($first: Int!) {
            giftCardCreatedForInstagrams(
              first: $first
              orderBy: blockTimestamp
              orderDirection: desc
            ) {
              id
              tokenId
              username
              sender
              amount
              token
              uri
              message
              blockNumber
              blockTimestamp
              transactionHash
            }
          }
        `,
        query: `
          query GetInstagramGiftCards($first: Int!, $blockTimestamp: BigInt!) {
            giftCardCreatedForInstagrams(
              first: $first
              orderBy: blockTimestamp
              orderDirection: desc
              where: { blockTimestamp_lt: $blockTimestamp }
            ) {
              id
              tokenId
              username
              sender
              amount
              token
              uri
              message
              blockNumber
              blockTimestamp
              transactionHash
            }
          }
        `
      }
    ];

    const allCards: any[] = [];

    // Fetch created events using blockTimestamp-based pagination
    let lastBlockTimestamp: number | null = null;
    let hasMore = true;
    while (hasMore && allCards.length < limit) {
      try {
        const queryToUse = lastBlockTimestamp === null ? createdQueryFirst : createdQuery;
        const variables: any = { first: batchSize };
        if (lastBlockTimestamp !== null) {
          variables.blockTimestamp = lastBlockTimestamp.toString();
        }

        const data = await queryTheGraph(queryToUse, variables, chainId);
        const events = data?.giftCardCreateds || [];
        
        if (events.length === 0) {
          hasMore = false;
        } else {
          events.forEach((event: any) => {
            allCards.push({
              chain_id: chainId,
              token_id: event.tokenId,
              sender_address: null,
              recipient_address: event.recipient?.toLowerCase() || null,
              recipient_username: null,
              recipient_type: 'address',
              amount: event.amount,
              currency: getTokenSymbol(event.token),
              message: event.message || '',
              redeemed: false,
              tx_hash: event.transactionHash,
              block_number: parseInt(event.blockNumber),
              block_timestamp: parseInt(event.blockTimestamp),
              event_type: 'GiftCardCreated',
              uri: event.uri || null,
            });
          });
          
          // Update lastBlockTimestamp to the smallest timestamp from this batch
          const timestamps = events.map((e: any) => parseInt(e.blockTimestamp));
          lastBlockTimestamp = Math.min(...timestamps);
          
          if (events.length < batchSize) {
            hasMore = false;
          }
        }
      } catch (error) {
        errors.push(`Error fetching created events: ${error instanceof Error ? error.message : 'Unknown error'}`);
        hasMore = false;
      }
    }

    // Fetch redeemed events and create a map using blockTimestamp-based pagination
    const redeemedMap = new Map<string, any>();
    lastBlockTimestamp = null;
    hasMore = true;
    while (hasMore && redeemedMap.size < limit) {
      try {
        const queryToUse = lastBlockTimestamp === null ? redeemedQueryFirst : redeemedQuery;
        const variables: any = { first: batchSize };
        if (lastBlockTimestamp !== null) {
          variables.blockTimestamp = lastBlockTimestamp.toString();
        }

        const data = await queryTheGraph(queryToUse, variables, chainId);
        const events = data?.giftCardRedeemeds || [];
        
        if (events.length === 0) {
          hasMore = false;
        } else {
          events.forEach((event: any) => {
            redeemedMap.set(event.tokenId, {
              redeemed: true,
              tx_hash: event.transactionHash,
              block_number: parseInt(event.blockNumber),
              block_timestamp: parseInt(event.blockTimestamp),
            });
          });
          
          // Update lastBlockTimestamp to the smallest timestamp from this batch
          const timestamps = events.map((e: any) => parseInt(e.blockTimestamp));
          lastBlockTimestamp = Math.min(...timestamps);
          
          if (events.length < batchSize) {
            hasMore = false;
          }
        }
      } catch (error) {
        errors.push(`Error fetching redeemed events: ${error instanceof Error ? error.message : 'Unknown error'}`);
        hasMore = false;
      }
    }

    // Merge redeemed status into created cards
    allCards.forEach(card => {
      const redeemed = redeemedMap.get(card.token_id);
      if (redeemed) {
        card.redeemed = true;
        if (redeemed.tx_hash && !card.tx_hash) {
          card.tx_hash = redeemed.tx_hash;
        }
      }
    });

    // Fetch social events using blockTimestamp-based pagination
    for (const { query, queryFirst, type, name } of socialQueries) {
      lastBlockTimestamp = null;
      hasMore = true;
      while (hasMore && allCards.length < limit) {
        try {
          const queryToUse = lastBlockTimestamp === null ? queryFirst : query;
          const variables: any = { first: batchSize };
          if (lastBlockTimestamp !== null) {
            variables.blockTimestamp = lastBlockTimestamp.toString();
          }

          const data = await queryTheGraph(queryToUse, variables, chainId);
          const events = data?.[name] || [];
          
          if (events.length === 0) {
            hasMore = false;
          } else {
            events.forEach((event: any) => {
              allCards.push({
                chain_id: chainId,
                token_id: event.tokenId,
                sender_address: event.sender?.toLowerCase() || null,
                recipient_address: null,
                recipient_username: event.username || null,
                recipient_type: type,
                amount: event.amount,
                currency: getTokenSymbol(event.token),
                message: event.message || '',
                redeemed: false,
                tx_hash: event.transactionHash,
                block_number: parseInt(event.blockNumber),
                block_timestamp: parseInt(event.blockTimestamp),
                event_type: `GiftCardCreatedFor${type.charAt(0).toUpperCase() + type.slice(1)}`,
                uri: event.uri || null,
              });
            });
            
            // Update lastBlockTimestamp to the smallest timestamp from this batch
            const timestamps = events.map((e: any) => parseInt(e.blockTimestamp));
            lastBlockTimestamp = Math.min(...timestamps);
            
            if (events.length < batchSize) {
              hasMore = false;
            }
          }
        } catch (error) {
          errors.push(`Error fetching ${type} events: ${error instanceof Error ? error.message : 'Unknown error'}`);
          hasMore = false;
        }
      }
    }

    // Update redeemed status for social cards
    allCards.forEach(card => {
      const redeemed = redeemedMap.get(card.token_id);
      if (redeemed) {
        card.redeemed = true;
      }
    });

    // Remove duplicates by token_id, keeping the most recent/complete version
    // Use Map to deduplicate - later entries override earlier ones
    const uniqueCardsMap = new Map<string, any>();
    allCards.forEach(card => {
      const tokenId = card.token_id;
      if (tokenId) {
        const dedupeKey = `${card.chain_id || chainId}:${tokenId}`;
        // If we already have this token_id, prefer the one with more data
        const existing = uniqueCardsMap.get(dedupeKey);
        if (existing) {
          // Prefer card with sender_address, recipient_address, or higher block_number
          const existingScore = (existing.sender_address ? 1 : 0) + 
                               (existing.recipient_address ? 1 : 0) + 
                               (existing.recipient_username ? 1 : 0) +
                               (existing.block_number || 0);
          const newScore = (card.sender_address ? 1 : 0) + 
                          (card.recipient_address ? 1 : 0) + 
                          (card.recipient_username ? 1 : 0) +
                          (card.block_number || 0);
          
          // Keep the one with higher score, or if equal, keep the new one (more recent)
          if (newScore >= existingScore) {
            uniqueCardsMap.set(dedupeKey, card);
          }
        } else {
          uniqueCardsMap.set(dedupeKey, card);
        }
      }
    });

    // Convert Map back to array
    const uniqueCards = Array.from(uniqueCardsMap.values());

    // Upsert to database in batches to avoid issues
    if (uniqueCards.length > 0) {
      const batchSize = 100;
      let syncedCount = 0;
      
      for (let i = 0; i < uniqueCards.length; i += batchSize) {
        const batch = uniqueCards.slice(i, i + batchSize);

        let upsertError: any = null;
        ({ error: upsertError } = await client
          .from('gift_cards_graph')
          .upsert(batch, {
            onConflict: 'chain_id,token_id',
            ignoreDuplicates: false,
          }));

        if (upsertError && isMissingChainIdColumnError(upsertError)) {
          console.warn('[GRAPH] chain_id missing on gift_cards_graph; falling back to legacy upsert');
          const legacyBatch = batch.map((row: any) => {
            const copy = { ...row };
            delete copy.chain_id;
            return copy;
          });
          ({ error: upsertError } = await client
            .from('gift_cards_graph')
            .upsert(legacyBatch, {
              onConflict: 'token_id',
              ignoreDuplicates: false,
            }));
        }

        if (upsertError) {
          throw new Error(`Database error: ${upsertError.message}`);
        }

        syncedCount += batch.length;
      }

      totalSynced = syncedCount;
    }

    return c.json({
      success: true,
      chain_id: chainId,
      synced: totalSynced,
      total: allCards.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Successfully synced ${totalSynced} gift cards from The Graph`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[GRAPH] Error syncing gift cards:', error);
    return c.json({ 
      error: 'Failed to sync gift cards from The Graph',
      details: errorMessage 
    }, 500);
  }
});

/**
 * Fill missing sender_address for gift cards from RPC
 * This function reads records from gift_cards_graph where sender_address is NULL
 * and fills them by fetching transaction data from RPC
 */
app.post('/graph/fill-missing-senders', async (c) => {
  try {
    const client = getSupabaseClient();
    const body = await c.req.json().catch(() => ({}));
    const { limit = 1000, batchSize = 50, concurrency = 3 } = body;
    const chainId = getChainIdFromRequest(c.req.query(), body);
    
    console.log(
      `[FILL-SENDERS] Starting to fill missing sender_address, chain_id=${chainId}, limit=${limit}, batchSize=${batchSize}, concurrency=${concurrency}`
    );
    
    // Get count of records with missing sender_address
    let count: number | null = null;
    let countError: any = null;
    ({ count, error: countError } = await client
      .from('gift_cards_graph')
      .select('*', { count: 'exact', head: true })
      .eq('chain_id', chainId)
      .is('sender_address', null)
      .not('tx_hash', 'is', null));

    if (countError && isMissingChainIdColumnError(countError)) {
      console.warn('[FILL-SENDERS] chain_id missing on gift_cards_graph; falling back to legacy query');
      ({ count, error: countError } = await client
        .from('gift_cards_graph')
        .select('*', { count: 'exact', head: true })
        .is('sender_address', null)
        .not('tx_hash', 'is', null));
    }
    
    if (countError) {
      throw new Error(`Failed to count records: ${countError.message}`);
    }
    
    const totalMissing = count || 0;
    console.log(`[FILL-SENDERS] Found ${totalMissing} records with missing sender_address`);
    
    if (totalMissing === 0) {
      return c.json({
        success: true,
        chain_id: chainId,
        message: 'No records with missing sender_address found',
        filled: 0,
        total: 0
      });
    }
    
    let processed = 0;
    let filled = 0;
    let errors: string[] = [];
    const processLimit = Math.min(limit, totalMissing);
    
    // Process in batches
    let offset = 0;
    while (processed < processLimit) {
      const currentBatchSize = Math.min(batchSize, processLimit - processed);
      
      // Fetch batch of records with missing sender_address
      let records: any[] | null = null;
      let fetchError: any = null;
      ({ data: records, error: fetchError } = await client
        .from('gift_cards_graph')
        .select('token_id, tx_hash, chain_id')
        .eq('chain_id', chainId)
        .is('sender_address', null)
        .not('tx_hash', 'is', null)
        .order('block_timestamp', { ascending: false })
        .range(offset, offset + currentBatchSize - 1));

      if (fetchError && isMissingChainIdColumnError(fetchError)) {
        console.warn('[FILL-SENDERS] chain_id missing on gift_cards_graph; falling back to legacy query');
        ({ data: records, error: fetchError } = await client
          .from('gift_cards_graph')
          .select('token_id, tx_hash')
          .is('sender_address', null)
          .not('tx_hash', 'is', null)
          .order('block_timestamp', { ascending: false })
          .range(offset, offset + currentBatchSize - 1));
      }
      
      if (fetchError) {
        throw new Error(`Failed to fetch records: ${fetchError.message}`);
      }
      
      if (!records || records.length === 0) {
        console.log(`[FILL-SENDERS] No more records to process`);
        break;
      }
      
      console.log(`[FILL-SENDERS] Processing batch: ${records.length} records (offset=${offset}, processed=${processed}/${processLimit})`);
      
      // Process records in parallel with concurrency limit
      const updates = await processInParallel(
        records,
        async (record: any) => {
          if (!record.tx_hash) {
            return { token_id: record.token_id, success: false, reason: 'no_tx_hash' };
          }
          
          try {
            const rpcChainId = resolveChainIdForGraphRecord(record, chainId);
            const senderAddress = await getSenderFromTransaction(record.tx_hash, rpcChainId);
            if (senderAddress) {
              // Update record in database
              let updateError: any = null;
              ({ error: updateError } = await client
                .from('gift_cards_graph')
                .update({ sender_address: senderAddress })
                .eq('chain_id', rpcChainId)
                .eq('token_id', record.token_id)
                .is('sender_address', null)); // Only update if still null (safety check)

              if (updateError && isMissingChainIdColumnError(updateError)) {
                ({ error: updateError } = await client
                  .from('gift_cards_graph')
                  .update({ sender_address: senderAddress })
                  .eq('token_id', record.token_id)
                  .is('sender_address', null));
              }
              
              if (updateError) {
                console.warn(`[FILL-SENDERS] Failed to update token ${record.token_id}:`, updateError);
                return { token_id: record.token_id, success: false, reason: 'update_failed', error: updateError.message };
              }
              
              return { token_id: record.token_id, success: true, sender_address: senderAddress };
            } else {
              return { token_id: record.token_id, success: false, reason: 'no_sender_found' };
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.warn(`[FILL-SENDERS] Error processing token ${record.token_id}:`, errorMsg);
            return { token_id: record.token_id, success: false, reason: 'rpc_error', error: errorMsg };
          }
        },
        concurrency,
        200 // 200ms delay between batches
      );
      
      // Count successes
      const batchFilled = updates.filter(u => u?.success).length;
      filled += batchFilled;
      processed += records.length;
      
      // Log errors
      const batchErrors = updates.filter(u => !u?.success);
      if (batchErrors.length > 0) {
        const errorSummary = batchErrors.slice(0, 5).map(e => `${e.token_id}: ${e.reason}`).join(', ');
        if (batchErrors.length > 5) {
          errors.push(`Batch errors (${batchErrors.length} total): ${errorSummary}...`);
        } else {
          errors.push(`Batch errors: ${errorSummary}`);
        }
      }
      
      console.log(`[FILL-SENDERS] Batch completed: ${batchFilled}/${records.length} filled, total filled: ${filled}/${processed}`);
      
      offset += currentBatchSize;
      
      // Small delay between batches to avoid overwhelming RPC
      if (processed < processLimit) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`[FILL-SENDERS] Completed: filled ${filled} out of ${processed} processed records`);
    
    return c.json({
      success: true,
      chain_id: chainId,
      filled,
      processed,
      total: totalMissing,
      remaining: Math.max(0, totalMissing - filled),
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined, // Limit errors in response
      message: `Filled ${filled} sender_address values out of ${processed} processed (${totalMissing} total missing)`
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[FILL-SENDERS] Error filling missing senders:', error);
    return c.json({ 
      error: 'Failed to fill missing sender addresses',
      details: errorMessage 
    }, 500);
  }
});

// ─── Gateway Unified Balance Routes ───

const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
const GATEWAY_API = 'https://gateway-api-testnet.circle.com/v1';
const GATEWAY_MAX_FEE = '2010000';

const USDC_MAP: Record<string, string> = {
  'ARC-TESTNET': '0x3600000000000000000000000000000000000000',
  'BASE-SEPOLIA': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};
const DOMAIN_MAP: Record<string, number> = {
  'ARC-TESTNET': 26,
  'BASE-SEPOLIA': 6,
};

function padBytes32(addr: string): string {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function parseUsdc6(amount: string): string {
  const [whole = '0', dec = ''] = String(amount).split('.');
  return (whole || '0') + (dec + '000000').slice(0, 6);
}

type CircleAuthResult =
  | { ok: true; apiKey: string; ciphertext: string }
  | { ok: false; error: string };

async function getCircleAuth(): Promise<CircleAuthResult> {
  const apiKey = Deno.env.get('CIRCLE_API_KEY');
  const secret = Deno.env.get('CIRCLE_ENTITY_SECRET');
  if (!apiKey || !secret) {
    return {
      ok: false,
      error:
        'Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET - add them as secrets for this Edge function (Dashboard → Edge Functions → Secrets), not only in the SPA .env',
    };
  }

  try {
    const hexSecret = secret.trim().replace(/^0x/i, '');
    const ciphertext = await reEncryptEntitySecretCiphertextGlobal(apiKey, hexSecret);
    return { ok: true, apiKey, ciphertext };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Entity secret ciphertext (RSA-OAEP): ${message}` };
  }
}

app.post('/gateway-deposit', async (c) => {
  try {
    const auth = await getCircleAuth();
    if (!auth.ok) {
      console.error('gateway-deposit Circle auth:', auth.error);
      return c.json({ success: false, error: 'Circle auth failed', details: auth.error }, 500);
    }

    const { walletAddress, chain, amount, blockchain } = await c.req.json();
    const DISPLAY_TO_BC: Record<string, string> = {
      'arc testnet': 'ARC-TESTNET',
      'base sepolia': 'BASE-SEPOLIA',
    };
    let bc = String(blockchain || chain || '').trim();
    if (!USDC_MAP[bc]) {
      const mapped = DISPLAY_TO_BC[bc.toLowerCase()];
      if (mapped) bc = mapped;
    }
    const usdc = USDC_MAP[bc];
    if (!usdc) return c.json({ success: false, error: `Unsupported chain: ${bc}` }, 400);
    if (!walletAddress || !amount) return c.json({ success: false, error: 'Missing walletAddress or amount' }, 400);

    const supabase = getSupabaseClient();
    const { data: wallet } = await supabase
      .from('developer_wallets')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();
    if (!wallet) return c.json({ success: false, error: 'Internal Wallet not found' }, 404);

    const circleEntitySecretHex = Deno.env.get('CIRCLE_ENTITY_SECRET')!.trim().replace(/^0x/i, '');

    const parsed = parseUsdc6(amount);

    const execTx = async (overrides: Record<string, unknown>) => {
      const ciphertext = await reEncryptEntitySecretCiphertextGlobal(auth.apiKey, circleEntitySecretHex);
      return fetch('https://api.circle.com/v1/w3s/developer/transactions/contractExecution', {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletId: wallet.circle_wallet_id,
          entitySecretCiphertext: ciphertext,
          feeLevel: 'MEDIUM',
          idempotencyKey: crypto.randomUUID(),
          ...overrides,
        }),
      });
    };

    const appRes = await execTx({
      contractAddress: usdc,
      abiFunctionSignature: 'approve(address,uint256)',
      abiParameters: [GATEWAY_WALLET, parsed],
    });
    if (!appRes.ok) return c.json({ success: false, error: `Approve failed: ${await appRes.text()}` }, 500);
    const appData = await appRes.json();
    const approveId = appData?.data?.id;
    if (!approveId) return c.json({ success: false, error: 'No approve transaction ID' }, 500);

    const depRes = await execTx({
      contractAddress: GATEWAY_WALLET,
      abiFunctionSignature: 'deposit(address,uint256)',
      abiParameters: [usdc, parsed],
    });
    if (!depRes.ok) return c.json({ success: false, error: `Deposit failed: ${await depRes.text()}` }, 500);
    const depData = await depRes.json();
    const depositId = depData?.data?.id;

    return c.json({ success: true, data: { approveTransactionId: approveId, depositTransactionId: depositId, amount, chain: bc } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('gateway-deposit:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
});

app.post('/gateway-spend', async (c) => {
  try {
    const auth = await getCircleAuth();
    if (!auth.ok) {
      console.error('gateway-spend Circle auth:', auth.error);
      return c.json({ success: false, error: 'Circle auth failed', details: auth.error }, 500);
    }

    const { walletAddress, sourceBlockchain, destinationBlockchain, recipientAddress, amount } = await c.req.json();
    if (!walletAddress || !amount || !recipientAddress) return c.json({ success: false, error: 'Missing required params' }, 400);

    const srcUsdc = USDC_MAP[sourceBlockchain];
    const dstUsdc = USDC_MAP[destinationBlockchain];
    const srcDomain = DOMAIN_MAP[sourceBlockchain];
    const dstDomain = DOMAIN_MAP[destinationBlockchain];
    if (!srcUsdc || !dstUsdc || srcDomain == null || dstDomain == null) return c.json({ success: false, error: 'Unsupported chain' }, 400);

    const supabase = getSupabaseClient();
    const { data: wallet } = await supabase
      .from('developer_wallets')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();
    if (!wallet) return c.json({ success: false, error: 'Internal Wallet not found' }, 404);

    const parsed = parseUsdc6(amount);
    const salt = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');

    const circleEntitySecretHex = Deno.env.get('CIRCLE_ENTITY_SECRET')!.trim().replace(/^0x/i, '');

    const burnIntent = {
      maxBlockHeight: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      maxFee: GATEWAY_MAX_FEE,
      spec: {
        version: 1, sourceDomain: srcDomain, destinationDomain: dstDomain,
        sourceContract: padBytes32(GATEWAY_WALLET), destinationContract: padBytes32(GATEWAY_MINTER),
        sourceToken: padBytes32(srcUsdc), destinationToken: padBytes32(dstUsdc),
        sourceDepositor: padBytes32(walletAddress), destinationRecipient: padBytes32(recipientAddress),
        sourceSigner: padBytes32(walletAddress), destinationCaller: padBytes32('0x0000000000000000000000000000000000000000'),
        value: parsed, salt: padBytes32(salt), hookData: '0x',
      },
    };

    const signCiphertext = await reEncryptEntitySecretCiphertextGlobal(auth.apiKey, circleEntitySecretHex);
    const signRes = await fetch(`https://api.circle.com/v1/w3s/developer/wallets/${wallet.circle_wallet_id}/signTypedData`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        typedData: {
          domain: { name: 'GatewayWallet', version: '1' },
          types: {
            EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }],
            TransferSpec: [
              { name: 'version', type: 'uint32' }, { name: 'sourceDomain', type: 'uint32' }, { name: 'destinationDomain', type: 'uint32' },
              { name: 'sourceContract', type: 'bytes32' }, { name: 'destinationContract', type: 'bytes32' },
              { name: 'sourceToken', type: 'bytes32' }, { name: 'destinationToken', type: 'bytes32' },
              { name: 'sourceDepositor', type: 'bytes32' }, { name: 'destinationRecipient', type: 'bytes32' },
              { name: 'sourceSigner', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' },
              { name: 'value', type: 'uint256' }, { name: 'salt', type: 'bytes32' }, { name: 'hookData', type: 'bytes' },
            ],
            BurnIntent: [
              { name: 'maxBlockHeight', type: 'uint256' }, { name: 'maxFee', type: 'uint256' }, { name: 'spec', type: 'TransferSpec' },
            ],
          },
          primaryType: 'BurnIntent',
        },
        entitySecretCiphertext: signCiphertext,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    if (!signRes.ok) return c.json({ success: false, error: `EIP-712 signing failed: ${await signRes.text()}` }, 500);
    const signData = await signRes.json();
    const signature = signData?.data?.signature;
    if (!signature) return c.json({ success: false, error: 'No signature' }, 500);

    const gwRes = await fetch(`${GATEWAY_API}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ burnIntent, signature }], (_, v) => typeof v === 'bigint' ? v.toString() : v),
    });
    if (!gwRes.ok) return c.json({ success: false, error: `Gateway transfer: ${await gwRes.text()}` }, 500);
    const [gwItem] = await gwRes.json();
    if (!gwItem?.attestation) return c.json({ success: false, error: 'No attestation' }, 500);

    const mintCiphertext = await reEncryptEntitySecretCiphertextGlobal(auth.apiKey, circleEntitySecretHex);
    const mintRes = await fetch('https://api.circle.com/v1/w3s/developer/transactions/contractExecution', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletId: wallet.circle_wallet_id,
        contractAddress: GATEWAY_MINTER,
        abiFunctionSignature: 'gatewayMint(bytes,bytes)',
        abiParameters: [gwItem.attestation, gwItem.signature],
        entitySecretCiphertext: mintCiphertext,
        feeLevel: 'MEDIUM',
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    if (!mintRes.ok) return c.json({ success: false, error: `Mint failed: ${await mintRes.text()}` }, 500);
    const mintData = await mintRes.json();

    return c.json({ success: true, data: { mintTransactionId: mintData?.data?.id, amount, destinationChain: destinationBlockchain, recipientAddress, attestation: gwItem.attestation } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('gateway-spend:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
});

// Wrapper for CORS handling at Deno.serve level
Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE, PATCH',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept, Origin',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
  };

  try {
    // Log incoming request for debugging
    const url = new URL(req.url);
    let pathname = url.pathname;
    console.log(`Incoming request: ${req.method} ${pathname}`);
    
    // Remove Edge Function slug prefix so Hono matches app routes (e.g. /gateway-deposit).
    // Path is often /{functionSlug}/rest (e.g. /smooth-processor/gateway-deposit).
    const functionSlug = Deno.env.get('SUPABASE_FUNCTION_NAME')?.trim();
    const slugPrefixes = [
      ...(functionSlug ? [`/${functionSlug}`] : []),
      '/smart-action-v2',
      '/smart-action',
      '/smooth-processor',
    ];
    for (const prefix of slugPrefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        pathname = pathname.slice(prefix.length) || '/';
        console.log(`Normalized path (stripped ${prefix}): ${pathname}`);
        break;
      }
    }
    
    // Handle OPTIONS requests with normalized path
    if (req.method === 'OPTIONS') {
      console.log('Handling OPTIONS preflight request for path:', pathname);
      return new Response(null, {
        status: 204,
        statusText: 'No Content',
        headers: new Headers(corsHeaders),
      });
    }
    
    // Create new URL with corrected path for Hono
    url.pathname = pathname;
    const normalizedReq = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    
    // Handle all other requests through Hono with normalized path
    const res = await app.fetch(normalizedReq);
    
    console.log(`Response status: ${res.status}`);

    // Always add CORS headers to response
    const headers = new Headers(res.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      headers.set(key, value);
    });

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: headers,
    });
  } catch (error) {
    // Error handling with CORS headers
    console.error('Unhandled error in Edge Function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      details: errorMessage 
    }), {
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers({
        ...corsHeaders,
        'Content-Type': 'application/json',
      }),
    });
  }
});