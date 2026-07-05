import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { Address } from 'npm:viem';
import { createArcPublicClient } from './arcRpc.ts';
import {
  paySocialIdentity,
  type PrPayoutDeps,
} from './prPayout.ts';
import {
  generateTwitchUidHash,
  twitchUidHandleSegment,
} from './twitchIdentity.ts';

export type TwitchCampaignRow = {
  id: string;
  sponsor_id: string;
  broadcaster_user_id: string;
  broadcaster_login_snapshot: string | null;
  name: string;
  total_budget_usdc: string;
  remaining_budget_usdc: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  sponsor_wallet_ref: string | null;
};

export type TwitchPolicyRow = {
  id: string;
  campaign_id: string;
  event_type: string;
  payout_kind: string;
  min_viewers: number;
  rate_per_viewer_usdc: string;
  max_per_event_usdc: string;
  max_per_day_usdc: string;
  allowlist_json: string[] | null;
  require_approval: boolean;
  enabled: boolean;
};

export type TwitchPayoutRow = {
  id: string;
  created_at: string;
  campaign_id: string;
  policy_id: string;
  recipient_twitch_user_id: string;
  recipient_login_snapshot: string | null;
  identity_hash: string;
  amount_usdc: string;
  evidence_json: Record<string, unknown> | null;
  twitch_message_id: string;
  status: string;
  payment_id: string | null;
  tx_hash: string | null;
  claim_status: string;
  skip_reason: string | null;
};

export type TwitchSettleResult = {
  status: string;
  payoutId?: string;
  skipReason?: string;
  paymentId?: string;
  txHash?: string;
};

function startOfUtcDayIso(): string {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

/** MVP: platform sponsor wallet; phase 2 reads campaign.sponsor_wallet_ref */
export function resolveSponsorWalletRef(campaign: TwitchCampaignRow): string | null {
  const ref = campaign.sponsor_wallet_ref?.trim();
  if (ref) return ref;
  return (
    Deno.env.get('PR_PAYOUT_SPONSOR_CIRCLE_WALLET_ID')?.trim() ||
    Deno.env.get('PR_PAYOUT_SPONSOR_WALLET_ID')?.trim() ||
    null
  );
}

export async function getPolicyDailyPaid(
  client: SupabaseClient,
  campaignId: string,
  policyId: string,
): Promise<number> {
  const since = startOfUtcDayIso();
  const { data, error } = await client
    .from('twitch_payouts')
    .select('amount_usdc')
    .eq('campaign_id', campaignId)
    .eq('policy_id', policyId)
    .eq('status', 'paid')
    .gte('created_at', since);
  if (error) return 0;
  return (data ?? []).reduce((s, r) => s + parseFloat(String(r.amount_usdc)), 0);
}

export async function getRaiderDailyPaid(
  client: SupabaseClient,
  campaignId: string,
  raiderUserId: string,
): Promise<number> {
  const since = startOfUtcDayIso();
  const { data, error } = await client
    .from('twitch_payouts')
    .select('amount_usdc')
    .eq('campaign_id', campaignId)
    .eq('recipient_twitch_user_id', raiderUserId)
    .eq('status', 'paid')
    .gte('created_at', since);
  if (error) return 0;
  return (data ?? []).reduce((s, r) => s + parseFloat(String(r.amount_usdc)), 0);
}

export async function hasRaiderPaidToday(
  client: SupabaseClient,
  campaignId: string,
  raiderUserId: string,
): Promise<boolean> {
  const since = startOfUtcDayIso();
  const { data } = await client
    .from('twitch_payouts')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('recipient_twitch_user_id', raiderUserId)
    .eq('status', 'paid')
    .gte('created_at', since)
    .limit(1);
  return Boolean(data?.length);
}

async function findExistingByMessageId(
  client: SupabaseClient,
  messageId: string,
): Promise<TwitchPayoutRow | null> {
  const { data } = await client
    .from('twitch_payouts')
    .select('*')
    .eq('twitch_message_id', messageId)
    .maybeSingle();
  return (data as TwitchPayoutRow | null) ?? null;
}

async function insertPayout(
  client: SupabaseClient,
  row: Record<string, unknown>,
): Promise<TwitchPayoutRow | null> {
  const { data, error } = await client.from('twitch_payouts').insert(row).select('*').single();
  if (error) {
    if (String(error.message).includes('duplicate') || error.code === '23505') return null;
    console.error('[twitch-payout-core] insert error:', error);
    throw error;
  }
  return data as TwitchPayoutRow;
}

async function updatePayout(
  client: SupabaseClient,
  id: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from('twitch_payouts').update(updates).eq('id', id);
  if (error) console.error('[twitch-payout-core] update error:', error);
}

async function debitCampaignBudget(
  client: SupabaseClient,
  campaignId: string,
  amountUsdc: number,
): Promise<void> {
  const { data } = await client
    .from('twitch_campaigns')
    .select('remaining_budget_usdc')
    .eq('id', campaignId)
    .single();
  if (!data) return;
  const remaining = parseFloat(String(data.remaining_budget_usdc));
  await client
    .from('twitch_campaigns')
    .update({
      remaining_budget_usdc: Math.max(0, remaining - amountUsdc),
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId);
}

/**
 * Twitch settlement funnel - isolated from GitHub payoutCore.
 * Pays twitch:uid:{userId} via paySocialIdentity(..., "twitch", "uid:"+userId, amount).
 */
export async function settleTwitchPayout(
  deps: PrPayoutDeps,
  params: {
    campaign: TwitchCampaignRow;
    policy: TwitchPolicyRow;
    recipientUserId: string;
    recipientLoginSnapshot?: string | null;
    amountUsdc: number;
    twitchMessageId: string;
    evidenceJson: Record<string, unknown>;
    skipReason?: string;
    preStatus?: string;
  },
): Promise<TwitchSettleResult> {
  const client = deps.getClient();
  const {
    campaign,
    policy,
    recipientUserId,
    recipientLoginSnapshot,
    amountUsdc,
    twitchMessageId,
    evidenceJson,
  } = params;

  const existing = await findExistingByMessageId(client, twitchMessageId);
  if (existing) {
    return { status: 'skipped_duplicate', payoutId: existing.id };
  }

  const identityHash = generateTwitchUidHash(recipientUserId);
  const baseRow = {
    campaign_id: campaign.id,
    policy_id: policy.id,
    payout_kind: policy.payout_kind,
    event_type: policy.event_type,
    recipient_twitch_user_id: recipientUserId,
    recipient_login_snapshot: recipientLoginSnapshot ?? null,
    identity_hash: identityHash,
    amount_usdc: amountUsdc,
    evidence_json: evidenceJson,
    twitch_message_id: twitchMessageId,
  };

  if (params.preStatus && params.skipReason) {
    const row = await insertPayout(client, {
      ...baseRow,
      status: params.preStatus,
      skip_reason: params.skipReason,
    });
    return { status: params.preStatus, payoutId: row?.id, skipReason: params.skipReason };
  }

  const budgetRemaining = parseFloat(String(campaign.remaining_budget_usdc));
  const policyDailyCap = parseFloat(String(policy.max_per_day_usdc));
  const policyDailyPaid = await getPolicyDailyPaid(client, campaign.id, policy.id);

  if (amountUsdc > budgetRemaining || policyDailyPaid + amountUsdc > policyDailyCap) {
    const row = await insertPayout(client, {
      ...baseRow,
      status: 'skipped_budget',
      skip_reason: 'budget_or_daily_cap',
    });
    return { status: 'skipped_budget', payoutId: row?.id, skipReason: 'budget_or_daily_cap' };
  }

  const processing = await insertPayout(client, { ...baseRow, status: 'processing' });
  if (!processing) {
    return { status: 'skipped_duplicate' };
  }

  const walletRef = resolveSponsorWalletRef(campaign);
  if (!walletRef) {
    await updatePayout(client, processing.id, {
      status: 'failed',
      skip_reason: 'sponsor_wallet_not_configured',
    });
    return { status: 'failed', payoutId: processing.id, skipReason: 'sponsor_wallet_not_configured' };
  }

  try {
    const handle = twitchUidHandleSegment(recipientUserId);
    const { paymentId, txHash } = await paySocialIdentity(deps, 'twitch', handle, amountUsdc);
    await updatePayout(client, processing.id, {
      status: 'paid',
      payment_id: paymentId,
      tx_hash: txHash,
      claim_status: 'pending',
    });
    await debitCampaignBudget(client, campaign.id, amountUsdc);
    return { status: 'paid', payoutId: processing.id, paymentId, txHash };
  } catch (err) {
    console.error('[twitch-payout-core] payment failed:', err);
    await updatePayout(client, processing.id, {
      status: 'failed',
      skip_reason: err instanceof Error ? err.message : 'payment_failed',
    });
    return { status: 'failed', payoutId: processing.id };
  }
}

export async function syncTwitchClaimStatuses(deps: PrPayoutDeps): Promise<number> {
  const client = deps.getClient();
  const { zkSendAddress } = deps.getArcConfig();
  const { data: pending } = await client
    .from('twitch_payouts')
    .select('id, payment_id')
    .eq('status', 'paid')
    .eq('claim_status', 'pending')
    .not('payment_id', 'is', null)
    .limit(50);

  if (!pending?.length) return 0;

  const publicClient = createArcPublicClient();
  let updated = 0;

  for (const row of pending) {
    if (!row.payment_id || !/^\d+$/.test(row.payment_id)) continue;
    try {
      const onChain = (await publicClient.readContract({
        address: zkSendAddress as Address,
        abi: [
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
        ],
        functionName: 'payments',
        args: [BigInt(row.payment_id)],
      })) as readonly unknown[];
      const claimed = Boolean(onChain[7]);
      if (claimed) {
        await updatePayout(client, row.id, { claim_status: 'claimed' });
        updated++;
      }
    } catch {
      // ignore per-row errors
    }
  }
  return updated;
}

export async function listTwitchPayouts(client: SupabaseClient): Promise<TwitchPayoutRow[]> {
  const { data, error } = await client
    .from('twitch_payouts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    console.error('[twitch-payout-core] list payouts error:', error);
    return [];
  }
  return (data ?? []) as TwitchPayoutRow[];
}
