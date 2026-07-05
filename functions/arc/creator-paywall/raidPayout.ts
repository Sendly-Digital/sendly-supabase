import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { PrPayoutDeps } from './prPayout.ts';
import {
  hasRaiderPaidToday,
  settleTwitchPayout,
  type TwitchCampaignRow,
  type TwitchPolicyRow,
} from './twitchPayoutCore.ts';
import { upsertTwitchIdentity } from './twitchIdentity.ts';

export type ChannelRaidEvent = {
  subscription: { type?: string };
  event: {
    from_broadcaster_user_id?: string;
    from_broadcaster_user_login?: string;
    from_broadcaster_user_name?: string;
    to_broadcaster_user_id?: string;
    to_broadcaster_user_login?: string;
    to_broadcaster_user_name?: string;
    viewers?: number;
  };
};

export function computeRaidAmount(
  viewers: number,
  policy: TwitchPolicyRow,
): { amount: number; skipReason?: string } {
  if (viewers < policy.min_viewers) {
    return { amount: 0, skipReason: 'below_min_viewers' };
  }
  const rate = parseFloat(String(policy.rate_per_viewer_usdc));
  const maxEvent = parseFloat(String(policy.max_per_event_usdc));
  const raw = viewers * rate;
  const amount = Math.min(raw, maxEvent);
  if (amount <= 0) {
    return { amount: 0, skipReason: 'zero_amount' };
  }
  return { amount };
}

function isInAllowlist(policy: TwitchPolicyRow, userId: string): boolean {
  const list = policy.allowlist_json;
  if (!list || !Array.isArray(list) || list.length === 0) return true;
  return list.map(String).includes(String(userId));
}

export async function loadActiveCampaignsForBroadcaster(
  client: SupabaseClient,
  broadcasterUserId: string,
): Promise<TwitchCampaignRow[]> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('twitch_campaigns')
    .select('*')
    .eq('broadcaster_user_id', broadcasterUserId)
    .eq('status', 'active');
  if (error) {
    console.error('[raid-payout] campaign load error:', error);
    return [];
  }
  return ((data ?? []) as TwitchCampaignRow[]).filter((c) => {
    if (c.starts_at && c.starts_at > now) return false;
    if (c.ends_at && c.ends_at < now) return false;
    return true;
  });
}

export async function loadRaidPolicy(
  client: SupabaseClient,
  campaignId: string,
): Promise<TwitchPolicyRow | null> {
  const { data, error } = await client
    .from('twitch_payout_policies')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('event_type', 'channel.raid')
    .eq('payout_kind', 'raid')
    .eq('enabled', true)
    .maybeSingle();
  if (error) {
    console.error('[raid-payout] policy load error:', error);
    return null;
  }
  return (data as TwitchPolicyRow | null) ?? null;
}

export async function processChannelRaid(
  deps: PrPayoutDeps,
  messageId: string,
  payload: ChannelRaidEvent,
): Promise<{ handled: boolean; results: Array<{ campaignId: string; status: string }> }> {
  const event = payload.event ?? {};
  const fromUserId = String(event.from_broadcaster_user_id ?? '').trim();
  const toUserId = String(event.to_broadcaster_user_id ?? '').trim();
  const viewers = typeof event.viewers === 'number' ? event.viewers : 0;
  const fromLogin = event.from_broadcaster_user_login?.trim().toLowerCase() ?? null;

  if (!fromUserId || !toUserId) {
    return { handled: false, results: [] };
  }

  const client = deps.getClient();
  const campaigns = await loadActiveCampaignsForBroadcaster(client, toUserId);
  if (!campaigns.length) {
    return { handled: true, results: [] };
  }

  await upsertTwitchIdentity(client, {
    userId: fromUserId,
    login: fromLogin,
    displayName: event.from_broadcaster_user_name ?? fromLogin,
  });

  const evidenceBase = {
    viewers,
    from_broadcaster_user_id: fromUserId,
    from_broadcaster_user_login: fromLogin,
    to_broadcaster_user_id: toUserId,
    to_broadcaster_user_login: event.to_broadcaster_user_login ?? null,
    twitch_message_id: messageId,
  };

  const results: Array<{ campaignId: string; status: string }> = [];

  for (const campaign of campaigns) {
    const policy = await loadRaidPolicy(client, campaign.id);
    if (!policy) {
      results.push({ campaignId: campaign.id, status: 'skipped_no_policy' });
      continue;
    }

    if (fromUserId === toUserId) {
      const r = await settleTwitchPayout(deps, {
        campaign,
        policy,
        recipientUserId: fromUserId,
        recipientLoginSnapshot: fromLogin,
        amountUsdc: 0,
        twitchMessageId: `${messageId}:${campaign.id}`,
        evidenceJson: evidenceBase,
        preStatus: 'skipped_self_raid',
        skipReason: 'self_raid',
      });
      results.push({ campaignId: campaign.id, status: r.status });
      continue;
    }

    if (!isInAllowlist(policy, fromUserId)) {
      const r = await settleTwitchPayout(deps, {
        campaign,
        policy,
        recipientUserId: fromUserId,
        recipientLoginSnapshot: fromLogin,
        amountUsdc: 0,
        twitchMessageId: `${messageId}:${campaign.id}`,
        evidenceJson: evidenceBase,
        preStatus: 'skipped_allowlist',
        skipReason: 'not_in_allowlist',
      });
      results.push({ campaignId: campaign.id, status: r.status });
      continue;
    }

    const { amount, skipReason } = computeRaidAmount(viewers, policy);
    if (skipReason) {
      const r = await settleTwitchPayout(deps, {
        campaign,
        policy,
        recipientUserId: fromUserId,
        recipientLoginSnapshot: fromLogin,
        amountUsdc: 0,
        twitchMessageId: `${messageId}:${campaign.id}`,
        evidenceJson: evidenceBase,
        preStatus: 'skipped_ineligible',
        skipReason,
      });
      results.push({ campaignId: campaign.id, status: r.status });
      continue;
    }

    const alreadyPaidToday = await hasRaiderPaidToday(client, campaign.id, fromUserId);
    if (alreadyPaidToday) {
      const r = await settleTwitchPayout(deps, {
        campaign,
        policy,
        recipientUserId: fromUserId,
        recipientLoginSnapshot: fromLogin,
        amountUsdc: 0,
        twitchMessageId: `${messageId}:${campaign.id}`,
        evidenceJson: evidenceBase,
        preStatus: 'skipped_daily_cap',
        skipReason: 'per_raider_daily_limit',
      });
      results.push({ campaignId: campaign.id, status: r.status });
      continue;
    }

    const r = await settleTwitchPayout(deps, {
      campaign,
      policy,
      recipientUserId: fromUserId,
      recipientLoginSnapshot: fromLogin,
      amountUsdc: amount,
      twitchMessageId: `${messageId}:${campaign.id}`,
      evidenceJson: evidenceBase,
    });
    results.push({ campaignId: campaign.id, status: r.status });
  }

  return { handled: true, results };
}
