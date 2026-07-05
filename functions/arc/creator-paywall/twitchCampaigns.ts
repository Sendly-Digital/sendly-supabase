import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { TwitchCampaignRow, TwitchPolicyRow } from './twitchPayoutCore.ts';
import {
  activateCampaignEventSub,
  revokeCampaignSubscriptions,
} from './twitchEventSubClient.ts';

export async function createCampaign(
  client: SupabaseClient,
  input: {
    sponsorId: string;
    broadcasterUserId: string;
    broadcasterLoginSnapshot?: string | null;
    name: string;
    totalBudgetUsdc: number;
    status?: string;
    startsAt?: string | null;
    endsAt?: string | null;
    sponsorWalletRef?: string | null;
  },
): Promise<TwitchCampaignRow | null> {
  const status = input.status ?? 'draft';
  const row = {
    sponsor_id: input.sponsorId,
    broadcaster_user_id: String(input.broadcasterUserId).trim(),
    broadcaster_login_snapshot: input.broadcasterLoginSnapshot?.trim().toLowerCase() ?? null,
    name: input.name.trim(),
    total_budget_usdc: input.totalBudgetUsdc,
    remaining_budget_usdc: input.totalBudgetUsdc,
    status,
    starts_at: input.startsAt ?? null,
    ends_at: input.endsAt ?? null,
    sponsor_wallet_ref: input.sponsorWalletRef ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await client.from('twitch_campaigns').insert(row).select('*').single();
  if (error) {
    console.error('[twitch-campaigns] create error:', error);
    return null;
  }

  const campaign = data as TwitchCampaignRow;
  if (status === 'active') {
    await activateCampaignEventSub(client, campaign.id, campaign.broadcaster_user_id);
  }
  return campaign;
}

export async function updateCampaign(
  client: SupabaseClient,
  campaignId: string,
  updates: {
    status?: string;
    totalBudgetUsdc?: number;
    remainingBudgetUsdc?: number;
    startsAt?: string | null;
    endsAt?: string | null;
    name?: string;
    broadcasterLoginSnapshot?: string | null;
  },
): Promise<TwitchCampaignRow | null> {
  const { data: existing } = await client
    .from('twitch_campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle();
  if (!existing) return null;

  const prev = existing as TwitchCampaignRow;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.status) patch.status = updates.status;
  if (updates.totalBudgetUsdc != null) patch.total_budget_usdc = updates.totalBudgetUsdc;
  if (updates.remainingBudgetUsdc != null) patch.remaining_budget_usdc = updates.remainingBudgetUsdc;
  if (updates.startsAt !== undefined) patch.starts_at = updates.startsAt;
  if (updates.endsAt !== undefined) patch.ends_at = updates.endsAt;
  if (updates.name) patch.name = updates.name.trim();
  if (updates.broadcasterLoginSnapshot !== undefined) {
    patch.broadcaster_login_snapshot = updates.broadcasterLoginSnapshot;
  }

  const { data, error } = await client
    .from('twitch_campaigns')
    .update(patch)
    .eq('id', campaignId)
    .select('*')
    .single();
  if (error) {
    console.error('[twitch-campaigns] update error:', error);
    return null;
  }

  const campaign = data as TwitchCampaignRow;
  const newStatus = updates.status ?? prev.status;

  if (newStatus === 'active' && prev.status !== 'active') {
    await activateCampaignEventSub(client, campaign.id, campaign.broadcaster_user_id);
  } else if ((newStatus === 'paused' || newStatus === 'ended') && prev.status === 'active') {
    await revokeCampaignSubscriptions(client, campaign.id);
  }

  return campaign;
}

export async function upsertRaidPolicy(
  client: SupabaseClient,
  input: {
    campaignId: string;
    minViewers?: number;
    ratePerViewerUsdc: number;
    maxPerEventUsdc: number;
    maxPerDayUsdc?: number;
    allowlistJson?: string[] | null;
    enabled?: boolean;
  },
): Promise<TwitchPolicyRow | null> {
  const row = {
    campaign_id: input.campaignId,
    event_type: 'channel.raid',
    payout_kind: 'raid',
    min_viewers: input.minViewers ?? 1,
    rate_per_viewer_usdc: input.ratePerViewerUsdc,
    max_per_event_usdc: input.maxPerEventUsdc,
    max_per_day_usdc: input.maxPerDayUsdc ?? 50,
    allowlist_json: input.allowlistJson ?? null,
    enabled: input.enabled !== false,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await client
    .from('twitch_payout_policies')
    .upsert(row, { onConflict: 'campaign_id,event_type,payout_kind' })
    .select('*')
    .single();

  if (error) {
    console.error('[twitch-campaigns] upsert policy error:', error);
    return null;
  }
  return data as TwitchPolicyRow;
}

export async function listCampaigns(client: SupabaseClient): Promise<TwitchCampaignRow[]> {
  const { data, error } = await client
    .from('twitch_campaigns')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[twitch-campaigns] list error:', error);
    return [];
  }
  return (data ?? []) as TwitchCampaignRow[];
}

export async function listPolicies(client: SupabaseClient): Promise<TwitchPolicyRow[]> {
  const { data, error } = await client
    .from('twitch_payout_policies')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[twitch-campaigns] list policies error:', error);
    return [];
  }
  return (data ?? []) as TwitchPolicyRow[];
}

export function serializeCampaign(c: TwitchCampaignRow) {
  return {
    id: c.id,
    sponsorId: c.sponsor_id,
    broadcasterUserId: c.broadcaster_user_id,
    broadcasterLoginSnapshot: c.broadcaster_login_snapshot,
    name: c.name,
    totalBudgetUsdc: c.total_budget_usdc,
    remainingBudgetUsdc: c.remaining_budget_usdc,
    status: c.status,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    sponsorWalletRef: c.sponsor_wallet_ref,
  };
}

export function serializePolicy(p: TwitchPolicyRow) {
  return {
    id: p.id,
    campaignId: p.campaign_id,
    eventType: p.event_type,
    payoutKind: p.payout_kind,
    minViewers: p.min_viewers,
    ratePerViewerUsdc: p.rate_per_viewer_usdc,
    maxPerEventUsdc: p.max_per_event_usdc,
    maxPerDayUsdc: p.max_per_day_usdc,
    allowlistJson: p.allowlist_json,
    requireApproval: p.require_approval,
    enabled: p.enabled,
  };
}
