import { keccak256, toBytes } from 'npm:viem';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export type SocialIdentityRow = {
  id: string;
  platform: string;
  external_user_id: string;
  handle: string | null;
  display_name: string | null;
  identity_hash: string;
  last_verified_at: string | null;
};

/** Canonical context message: twitch:uid:{user_id} */
export function buildTwitchUidIdentity(userId: string | number): string {
  return `twitch:uid:${String(userId).trim()}`;
}

/** keccak256("twitch:uid:{user_id}") */
export function generateTwitchUidHash(userId: string | number): `0x${string}` {
  return keccak256(toBytes(buildTwitchUidIdentity(userId)));
}

/** Handle segment for paySocialIdentity: "uid:{user_id}" → hash twitch:uid:{id} */
export function twitchUidHandleSegment(userId: string | number): string {
  return `uid:${String(userId).trim()}`;
}

export async function getSocialIdentity(
  client: SupabaseClient,
  platform: string,
  externalUserId: string,
): Promise<SocialIdentityRow | null> {
  const { data, error } = await client
    .from('social_identities')
    .select('*')
    .eq('platform', platform)
    .eq('external_user_id', externalUserId)
    .maybeSingle();
  if (error) {
    console.error('[twitch-identity] get error:', error);
    return null;
  }
  return (data as SocialIdentityRow | null) ?? null;
}

export async function upsertTwitchIdentity(
  client: SupabaseClient,
  params: {
    userId: string | number;
    login?: string | null;
    displayName?: string | null;
  },
): Promise<SocialIdentityRow | null> {
  const externalUserId = String(params.userId).trim();
  const identityHash = generateTwitchUidHash(externalUserId);
  const now = new Date().toISOString();

  const row = {
    platform: 'twitch',
    external_user_id: externalUserId,
    handle: params.login?.trim().toLowerCase() ?? null,
    display_name: params.displayName?.trim() ?? null,
    identity_hash: identityHash,
    last_verified_at: now,
    updated_at: now,
  };

  const { data, error } = await client
    .from('social_identities')
    .upsert(row, { onConflict: 'platform,external_user_id' })
    .select('*')
    .single();

  if (error) {
    console.error('[twitch-identity] upsert error:', error);
    return null;
  }
  return data as SocialIdentityRow;
}
