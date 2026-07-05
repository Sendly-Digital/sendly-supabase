import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

type AppAccessToken = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

function getTwitchClientId(): string | null {
  return Deno.env.get('TWITCH_CLIENT_ID')?.trim() || Deno.env.get('VITE_TWITCH_CLIENT_ID')?.trim() || null;
}

function getTwitchClientSecret(): string | null {
  return Deno.env.get('TWITCH_CLIENT_SECRET')?.trim() || null;
}

export function getTwitchWebhookCallbackUrl(): string {
  const explicit = Deno.env.get('TWITCH_EVENTSUB_CALLBACK_URL')?.trim();
  if (explicit) return explicit;
  const base =
    Deno.env.get('PUBLIC_CREATOR_PAYWALL_URL')?.trim() ||
    `${Deno.env.get('SUPABASE_URL')?.trim()}/functions/v1/creator-paywall`;
  return `${base.replace(/\/$/, '')}/webhooks/twitch`;
}

export async function getAppAccessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const clientId = getTwitchClientId();
  const clientSecret = getTwitchClientSecret();
  if (!clientId || !clientSecret) {
    console.error('[twitch-eventsub] missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET');
    return null;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });

  const res = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, { method: 'POST' });
  if (!res.ok) {
    console.error('[twitch-eventsub] token request failed:', res.status);
    return null;
  }

  const data = (await res.json()) as AppAccessToken;
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

export type EventSubSubscription = {
  id: string;
  type: string;
  version: string;
  status: string;
  condition: Record<string, string>;
  transport: { method: string; callback: string; secret?: string };
  created_at: string;
};

export async function createRaidSubscription(
  toBroadcasterUserId: string,
): Promise<{ subscription: EventSubSubscription; secret: string } | null> {
  const token = await getAppAccessToken();
  const clientId = getTwitchClientId();
  if (!token || !clientId) return null;

  const callback = getTwitchWebhookCallbackUrl();
  const body = {
    type: 'channel.raid',
    version: '1',
    condition: { to_broadcaster_user_id: toBroadcasterUserId },
    transport: {
      method: 'webhook',
      callback,
      secret: crypto.randomUUID().replace(/-/g, ''),
    },
  };

  const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[twitch-eventsub] create subscription failed:', res.status, errText);
    return null;
  }

  const parsed = (await res.json()) as { data?: EventSubSubscription[] };
  const sub = parsed.data?.[0];
  if (!sub) return null;

  const secret = body.transport.secret;
  return { subscription: sub, secret };
}

export async function deleteEventSubSubscription(subscriptionId: string): Promise<boolean> {
  const token = await getAppAccessToken();
  const clientId = getTwitchClientId();
  if (!token || !clientId) return false;

  const params = new URLSearchParams({ id: subscriptionId });
  const res = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?${params}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId,
    },
  });

  if (!res.ok && res.status !== 204) {
    console.error('[twitch-eventsub] delete subscription failed:', res.status);
    return false;
  }
  return true;
}

export async function persistEventSubSubscription(
  client: SupabaseClient,
  params: {
    subscriptionId: string;
    type: string;
    version: string;
    condition: Record<string, unknown>;
    secret: string;
    campaignId: string;
  },
): Promise<void> {
  const { error } = await client.from('twitch_eventsub_subscriptions').upsert(
    {
      subscription_id: params.subscriptionId,
      type: params.type,
      version: params.version,
      condition: params.condition,
      status: 'enabled',
      secret_ref: params.secret,
      campaign_id: params.campaignId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'subscription_id' },
  );
  if (error) console.error('[twitch-eventsub] persist subscription error:', error);
}

export async function revokeCampaignSubscriptions(
  client: SupabaseClient,
  campaignId: string,
): Promise<number> {
  const { data } = await client
    .from('twitch_eventsub_subscriptions')
    .select('subscription_id')
    .eq('campaign_id', campaignId)
    .eq('status', 'enabled');

  let revoked = 0;
  for (const row of data ?? []) {
    const subId = (row as { subscription_id: string }).subscription_id;
    const ok = await deleteEventSubSubscription(subId);
    if (ok) {
      await client
        .from('twitch_eventsub_subscriptions')
        .update({ status: 'revoked', updated_at: new Date().toISOString() })
        .eq('subscription_id', subId);
      revoked++;
    }
  }
  return revoked;
}

export async function activateCampaignEventSub(
  client: SupabaseClient,
  campaignId: string,
  broadcasterUserId: string,
): Promise<{ subscriptionId?: string; error?: string }> {
  const existing = await client
    .from('twitch_eventsub_subscriptions')
    .select('subscription_id, status')
    .eq('campaign_id', campaignId)
    .eq('status', 'enabled')
    .maybeSingle();

  if (existing.data?.subscription_id) {
    return { subscriptionId: existing.data.subscription_id };
  }

  const created = await createRaidSubscription(broadcasterUserId);
  if (!created) {
    return { error: 'eventsub_create_failed' };
  }

  await persistEventSubSubscription(client, {
    subscriptionId: created.subscription.id,
    type: created.subscription.type,
    version: created.subscription.version,
    condition: created.subscription.condition,
    secret: created.secret,
    campaignId,
  });

  return { subscriptionId: created.subscription.id };
}
