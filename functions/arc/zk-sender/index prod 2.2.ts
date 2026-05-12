import { Hono } from 'npm:hono';
import { cors } from 'npm:hono/cors';
import { logger } from 'npm:hono/logger';
import { createClient } from 'npm:@supabase/supabase-js@2';

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
    ],
  });
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

    const client = getSupabaseClient();
    const { data, error } = await client
      .from('zksend_payments')
      .upsert(
        {
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
        { onConflict: 'payment_id' }
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

    const client = getSupabaseClient();
    const { data, error } = await client
      .from('zksend_payments')
      .upsert(
        {
          payment_id: paymentId,
          sender_address: senderAddress,
          recipient_identity_hash: identityHash,
          social_platform: normalizedPlatform,
          ...(recipientUsernameClaim != null && { recipient_username: recipientUsernameClaim }),
          ...(recipientUsernameRawClaim != null && { recipient_username_raw: recipientUsernameRawClaim }),
          amount,
          currency,
          tx_hash: txHash,
          recipient_wallet: recipientWallet,
          claimed: true,
          claimed_at: new Date().toISOString(),
          claim_tx_hash: claimTxHash,
        },
        { onConflict: 'payment_id' }
      )
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
