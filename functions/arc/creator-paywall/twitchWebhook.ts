import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const MAX_TIMESTAMP_SKEW_MS = 10 * 60 * 1000;

export type TwitchWebhookHeaders = {
  messageId: string;
  timestamp: string;
  signature: string;
  messageType: string;
  subscriptionType?: string;
  subscriptionId?: string;
};

export function parseTwitchWebhookHeaders(headers: Headers): TwitchWebhookHeaders | null {
  const messageId = headers.get('Twitch-Eventsub-Message-Id')?.trim();
  const timestamp = headers.get('Twitch-Eventsub-Message-Timestamp')?.trim();
  const signature = headers.get('Twitch-Eventsub-Message-Signature')?.trim();
  const messageType = headers.get('Twitch-Eventsub-Message-Type')?.trim();
  if (!messageId || !timestamp || !signature || !messageType) return null;
  return {
    messageId,
    timestamp,
    signature,
    messageType,
    subscriptionType: headers.get('Twitch-Eventsub-Subscription-Type')?.trim(),
    subscriptionId: headers.get('Twitch-Eventsub-Subscription-Id')?.trim(),
  };
}

function isTimestampFresh(timestamp: string): boolean {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Date.now() - ts) <= MAX_TIMESTAMP_SKEW_MS;
}

export async function verifyTwitchWebhookHmac(
  secret: string,
  messageId: string,
  timestamp: string,
  body: string,
  signatureHeader: string,
): Promise<boolean> {
  if (!secret.trim() || !signatureHeader.startsWith('sha256=')) return false;
  if (!isTimestampFresh(timestamp)) return false;

  const message = messageId + timestamp + body;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const expected = 'sha256=' +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  const provided = signatureHeader.toLowerCase();
  const expectedLower = expected.toLowerCase();
  if (expectedLower.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedLower.length; i++) {
    diff |= expectedLower.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export async function lookupSubscriptionSecret(
  client: SupabaseClient,
  subscriptionId: string | undefined,
): Promise<string | null> {
  if (!subscriptionId) {
    return Deno.env.get('TWITCH_EVENTSUB_SECRET')?.trim() || null;
  }
  const { data } = await client
    .from('twitch_eventsub_subscriptions')
    .select('secret_ref')
    .eq('subscription_id', subscriptionId)
    .maybeSingle();
  return data?.secret_ref?.trim() || Deno.env.get('TWITCH_EVENTSUB_SECRET')?.trim() || null;
}

export async function insertEventSubDedupe(
  client: SupabaseClient,
  messageId: string,
): Promise<'new' | 'duplicate'> {
  const { error } = await client.from('twitch_eventsub_dedupe').insert({ message_id: messageId });
  if (error) {
    if (String(error.message).includes('duplicate') || error.code === '23505') {
      return 'duplicate';
    }
    console.error('[twitch-webhook] dedupe insert error:', error);
    throw error;
  }
  return 'new';
}

export async function markSubscriptionRevoked(
  client: SupabaseClient,
  subscriptionId: string,
): Promise<void> {
  const { error } = await client
    .from('twitch_eventsub_subscriptions')
    .update({ status: 'revoked', updated_at: new Date().toISOString() })
    .eq('subscription_id', subscriptionId);
  if (error) console.error('[twitch-webhook] revoke update error:', error);
}

export function extractVerificationChallenge(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { challenge?: string };
    return typeof parsed.challenge === 'string' ? parsed.challenge : null;
  } catch {
    return null;
  }
}
