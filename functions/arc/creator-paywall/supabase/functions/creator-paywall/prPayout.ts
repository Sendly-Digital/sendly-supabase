import {
  keccak256,
  parseEventLogs,
  toBytes,
  type Address,
} from 'npm:viem';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { createArcPublicClient } from './arcRpc.ts';
import { isBotLogin, normalizeLogin } from './payoutCore.ts';

const FEE_BPS = 10n;
const BPS_DENOMINATOR = 10000n;

const ZKSEND_PAYMENT_CREATED_ABI = [
  {
    type: 'event',
    name: 'PaymentCreated',
    inputs: [
      { indexed: true, name: 'paymentId', type: 'uint256' },
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: true, name: 'socialIdentityHash', type: 'bytes32' },
      { indexed: false, name: 'platform', type: 'string' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'token', type: 'address' },
    ],
  },
] as const;

export type PrPayoutPolicyRow = {
  id: string;
  repo_id: number;
  repo_full_name: string;
  sponsor_pool_ref: string;
  per_pr_amount_usdc: string;
  daily_cap_usdc: string;
  budget_remaining_usdc: string;
  active: boolean;
  bounty_enabled?: boolean;
  release_pool_usdc?: string;
  split_mode?: string;
  review_amount_usdc?: string;
  review_min_chars?: number;
  max_reviewers_per_pr?: number;
};

export type PrPayoutReceiptRow = {
  id: string;
  created_at: string;
  repo_id: number;
  repo_full_name: string;
  pr_number: number;
  author_login: string;
  identity_hash: string;
  amount_usdc: string;
  status: string;
  payment_id: string | null;
  tx_hash: string | null;
  claim_status: string;
  skip_reason: string | null;
  merged_by_login: string | null;
};

type SponsorWalletRow = {
  circle_wallet_id: string;
  wallet_address: string;
  privy_user_id: string | null;
  user_id: string | null;
  social_platform: string | null;
  social_user_id: string | null;
};

type ArcConfig = {
  chainId: string;
  usdcAddress: string;
  zkSendAddress: string;
  rpcUrl: string;
};

export type PrPayoutDeps = {
  getClient: () => SupabaseClient;
  getArcConfig: () => ArcConfig;
  generateIdentityHash: (platform: string, username: string) => `0x${string}`;
};

function parseUsdcToWei(priceUsdc: number): bigint {
  return BigInt(Math.round(priceUsdc * 1_000_000));
}

function getServerBaseUrl(): string {
  return (
    Deno.env.get('SENDLY_SERVER_FUNCTION_URL')?.trim() ||
    `${Deno.env.get('SUPABASE_URL')?.trim()}/functions/v1/smart-action`
  ).replace(/\/$/, '');
}

async function pollTransactionStatus(transactionId: string): Promise<string> {
  const base = getServerBaseUrl();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(
      `${base}/wallets/transaction-status?transactionId=${encodeURIComponent(transactionId)}`,
    );
    if (!res.ok) continue;
    const data = (await res.json()) as {
      transactionState?: string;
      txHash?: string;
      error?: string;
    };
    if (data.transactionState === 'FAILED') {
      throw new Error(data.error ?? 'Transaction failed');
    }
    if (data.txHash) return data.txHash;
  }
  throw new Error('Transaction status timeout');
}

async function sendSponsorTransaction(params: {
  wallet: SponsorWalletRow;
  contractAddress: string;
  functionName: string;
  args: unknown[];
  blockchain: string;
}): Promise<{ txHash?: string; transactionId?: string; success?: boolean; error?: string }> {
  const base = getServerBaseUrl();
  const body: Record<string, unknown> = {
    walletId: params.wallet.circle_wallet_id,
    walletAddress: params.wallet.wallet_address,
    contractAddress: params.contractAddress,
    functionName: params.functionName,
    args: params.args,
    blockchain: params.blockchain,
  };
  if (params.wallet.privy_user_id) body.privyUserId = params.wallet.privy_user_id;
  else if (params.wallet.user_id) body.privyUserId = params.wallet.user_id;
  if (params.wallet.social_platform && params.wallet.social_user_id) {
    body.socialPlatform = params.wallet.social_platform;
    body.socialUserId = params.wallet.social_user_id;
  }

  const res = await fetch(`${base}/wallets/send-transaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as {
    txHash?: string;
    transactionId?: string;
    success?: boolean;
    error?: string;
  };
}

async function loadSponsorWallet(client: SupabaseClient): Promise<SponsorWalletRow | null> {
  const walletId =
    Deno.env.get('PR_PAYOUT_SPONSOR_CIRCLE_WALLET_ID')?.trim() ||
    Deno.env.get('PR_PAYOUT_SPONSOR_WALLET_ID')?.trim();
  if (!walletId) return null;

  const { data, error } = await client
    .from('developer_wallets')
    .select('circle_wallet_id, wallet_address, privy_user_id, user_id, social_platform, social_user_id')
    .eq('circle_wallet_id', walletId)
    .maybeSingle();

  if (error) {
    console.error('[pr-payout] sponsor wallet lookup failed:', error);
    return null;
  }
  return data as SponsorWalletRow | null;
}

async function executeZkSendPayment(
  deps: PrPayoutDeps,
  wallet: SponsorWalletRow,
  identityHash: `0x${string}`,
  platform: string,
  amountUsdc: number,
): Promise<{ paymentId: string; txHash: string }> {
  const { usdcAddress, zkSendAddress } = deps.getArcConfig();
  const amountWei = parseUsdcToWei(amountUsdc);
  const feeWei = (amountWei * FEE_BPS) / BPS_DENOMINATOR;
  const totalWei = amountWei + feeWei;

  const approveRes = await sendSponsorTransaction({
    wallet,
    contractAddress: usdcAddress,
    functionName: 'approve',
    args: [zkSendAddress, totalWei.toString()],
    blockchain: 'ARC-TESTNET',
  });
  if (!approveRes.success && !approveRes.txHash) {
    throw new Error(approveRes.error ?? 'USDC approve failed');
  }
  if (approveRes.transactionId && !approveRes.txHash) {
    await pollTransactionStatus(approveRes.transactionId);
  }

  const createRes = await sendSponsorTransaction({
    wallet,
    contractAddress: zkSendAddress,
    functionName: 'createPayment',
    args: [identityHash, platform, amountWei.toString(), usdcAddress],
    blockchain: 'ARC-TESTNET',
  });
  if (!createRes.success && !createRes.txHash) {
    throw new Error(createRes.error ?? 'createPayment failed');
  }

  let txHash = createRes.txHash ?? '';
  if (!txHash && createRes.transactionId) {
    txHash = await pollTransactionStatus(createRes.transactionId);
  }
  if (!txHash) throw new Error('Missing transaction hash');

  const publicClient = createArcPublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash as `0x${string}`,
    timeout: 60_000,
    pollingInterval: 1_500,
    retryCount: 10,
  });
  const parsed = parseEventLogs({
    abi: ZKSEND_PAYMENT_CREATED_ABI,
    logs: receipt.logs,
    eventName: 'PaymentCreated',
  });
  const paymentId = parsed[0]?.args?.paymentId?.toString();
  if (!paymentId) throw new Error('Could not read paymentId from chain');

  return { paymentId, txHash };
}

export async function paySocialIdentity(
  deps: PrPayoutDeps,
  platform: string,
  handle: string,
  amountUsdc: number,
): Promise<{ paymentId: string; txHash: string }> {
  const client = deps.getClient();
  const sponsorWallet = await loadSponsorWallet(client);
  if (!sponsorWallet) throw new Error('sponsor_wallet_not_configured');
  const identityHash = deps.generateIdentityHash(platform, handle);
  return executeZkSendPayment(deps, sponsorWallet, identityHash, platform, amountUsdc);
}

export async function loadPolicyByRepoId(
  client: SupabaseClient,
  repoId: number,
): Promise<PrPayoutPolicyRow | null> {
  const { data, error } = await client
    .from('pr_payout_policies')
    .select('*')
    .eq('repo_id', repoId)
    .maybeSingle();
  if (error) {
    console.error('[pr-payout] policy load error:', error);
    return null;
  }
  return data as PrPayoutPolicyRow | null;
}

export async function listPolicies(client: SupabaseClient): Promise<PrPayoutPolicyRow[]> {
  const { data, error } = await client.from('pr_payout_policies').select('*').order('repo_full_name');
  if (error) {
    console.error('[pr-payout] list policies error:', error);
    return [];
  }
  return (data ?? []) as PrPayoutPolicyRow[];
}

export async function listReceipts(client: SupabaseClient): Promise<PrPayoutReceiptRow[]> {
  const { data, error } = await client
    .from('github_pr_payouts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    console.error('[pr-payout] list receipts error:', error);
    return [];
  }
  return (data ?? []) as PrPayoutReceiptRow[];
}

async function getDailyPaidTotal(
  client: SupabaseClient,
  repoId: number,
): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await client
    .from('github_pr_payouts')
    .select('amount_usdc')
    .eq('repo_id', repoId)
    .eq('status', 'paid')
    .gte('created_at', start.toISOString());
  if (error) return 0;
  return (data ?? []).reduce((sum, row) => sum + parseFloat(String(row.amount_usdc)), 0);
}

async function findExistingReceipt(
  client: SupabaseClient,
  repoId: number,
  prNumber: number,
): Promise<PrPayoutReceiptRow | null> {
  const { data } = await client
    .from('github_pr_payouts')
    .select('*')
    .eq('repo_id', repoId)
    .eq('pr_number', prNumber)
    .maybeSingle();
  return (data as PrPayoutReceiptRow | null) ?? null;
}

async function insertReceipt(
  client: SupabaseClient,
  row: Record<string, unknown>,
): Promise<PrPayoutReceiptRow | null> {
  const { data, error } = await client.from('github_pr_payouts').insert(row).select('*').single();
  if (error) {
    if (String(error.message).includes('duplicate') || error.code === '23505') return null;
    console.error('[pr-payout] insert receipt error:', error);
    throw error;
  }
  return data as PrPayoutReceiptRow;
}

async function updateReceipt(
  client: SupabaseClient,
  id: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from('github_pr_payouts').update(updates).eq('id', id);
  if (error) console.error('[pr-payout] update receipt error:', error);
}

export type GithubPullRequestPayload = {
  action?: string;
  pull_request?: {
    number?: number;
    merged?: boolean;
    user?: { login?: string };
    merged_by?: { login?: string } | null;
  };
  repository?: {
    id?: number;
    full_name?: string;
  };
};

export async function processMergedPullRequestWebhook(
  deps: PrPayoutDeps,
  payload: GithubPullRequestPayload,
): Promise<{ handled: boolean; receiptId?: string; status?: string }> {
  if (payload.action !== 'closed' || !payload.pull_request?.merged) {
    return { handled: false };
  }

  const repoId = payload.repository?.id;
  const repoFullName = payload.repository?.full_name ?? '';
  const prNumber = payload.pull_request?.number;
  const authorLogin = normalizeLogin(payload.pull_request?.user?.login);
  const mergedByLogin = normalizeLogin(payload.pull_request?.merged_by?.login);

  if (repoId == null || prNumber == null || !authorLogin) {
    return { handled: false };
  }

  const client = deps.getClient();
  const existing = await findExistingReceipt(client, repoId, prNumber);
  if (existing) {
    return { handled: true, receiptId: existing.id, status: 'skipped_duplicate' };
  }

  const policy = await loadPolicyByRepoId(client, repoId);
  const amountUsdc = policy ? parseFloat(String(policy.per_pr_amount_usdc)) : 0;
  const identityHash = deps.generateIdentityHash('github', authorLogin);

  if (!policy || !policy.active) {
    const row = await insertReceipt(client, {
      repo_id: repoId,
      repo_full_name: repoFullName,
      pr_number: prNumber,
      author_login: authorLogin,
      identity_hash: identityHash,
      amount_usdc: amountUsdc || 0,
      status: policy ? 'skipped_inactive' : 'skipped_no_policy',
      skip_reason: policy ? 'policy_inactive' : 'no_policy',
      merged_by_login: mergedByLogin,
    });
    return { handled: true, receiptId: row?.id, status: policy ? 'skipped_inactive' : 'skipped_no_policy' };
  }

  if (isBotLogin(authorLogin)) {
    const row = await insertReceipt(client, {
      repo_id: repoId,
      repo_full_name: repoFullName,
      pr_number: prNumber,
      author_login: authorLogin,
      identity_hash: identityHash,
      amount_usdc: amountUsdc,
      status: 'skipped_bot',
      skip_reason: 'bot_author',
      merged_by_login: mergedByLogin,
    });
    return { handled: true, receiptId: row?.id, status: 'skipped_bot' };
  }

  if (mergedByLogin && authorLogin === mergedByLogin) {
    const row = await insertReceipt(client, {
      repo_id: repoId,
      repo_full_name: repoFullName,
      pr_number: prNumber,
      author_login: authorLogin,
      identity_hash: identityHash,
      amount_usdc: amountUsdc,
      status: 'skipped_self_merge',
      skip_reason: 'self_merge',
      merged_by_login: mergedByLogin,
    });
    return { handled: true, receiptId: row?.id, status: 'skipped_self_merge' };
  }

  const dailyCap = parseFloat(String(policy.daily_cap_usdc));
  const budgetRemaining = parseFloat(String(policy.budget_remaining_usdc));
  const dailyPaid = await getDailyPaidTotal(client, repoId);

  if (amountUsdc > budgetRemaining || dailyPaid + amountUsdc > dailyCap) {
    const row = await insertReceipt(client, {
      repo_id: repoId,
      repo_full_name: repoFullName,
      pr_number: prNumber,
      author_login: authorLogin,
      identity_hash: identityHash,
      amount_usdc: amountUsdc,
      status: 'skipped_budget',
      skip_reason: 'budget_or_daily_cap',
      merged_by_login: mergedByLogin,
    });
    return { handled: true, receiptId: row?.id, status: 'skipped_budget' };
  }

  const processing = await insertReceipt(client, {
    repo_id: repoId,
    repo_full_name: repoFullName,
    pr_number: prNumber,
    author_login: authorLogin,
    identity_hash: identityHash,
    amount_usdc: amountUsdc,
    status: 'processing',
    merged_by_login: mergedByLogin,
  });
  if (!processing) {
    return { handled: true, status: 'skipped_duplicate' };
  }

  const sponsorWallet = await loadSponsorWallet(client);
  if (!sponsorWallet) {
    await updateReceipt(client, processing.id, {
      status: 'failed',
      skip_reason: 'sponsor_wallet_not_configured',
    });
    return { handled: true, receiptId: processing.id, status: 'failed' };
  }

  try {
    const { paymentId, txHash } = await executeZkSendPayment(
      deps,
      sponsorWallet,
      identityHash,
      'github',
      amountUsdc,
    );
    await updateReceipt(client, processing.id, {
      status: 'paid',
      payment_id: paymentId,
      tx_hash: txHash,
      claim_status: 'pending',
    });
    await client
      .from('pr_payout_policies')
      .update({
        budget_remaining_usdc: Math.max(0, budgetRemaining - amountUsdc),
        updated_at: new Date().toISOString(),
      })
      .eq('id', policy.id);

    return { handled: true, receiptId: processing.id, status: 'paid' };
  } catch (err) {
    console.error('[pr-payout] payment failed:', err);
    await updateReceipt(client, processing.id, {
      status: 'failed',
      skip_reason: err instanceof Error ? err.message : 'payment_failed',
    });
    return { handled: true, receiptId: processing.id, status: 'failed' };
  }
}

export async function upsertPolicy(
  client: SupabaseClient,
  input: {
    repoId: number;
    repoFullName: string;
    perPrAmountUsdc: number;
    dailyCapUsdc?: number;
    budgetRemainingUsdc?: number;
    active?: boolean;
    bountyEnabled?: boolean;
    releasePoolUsdc?: number;
    splitMode?: string;
    reviewAmountUsdc?: number;
    reviewMinChars?: number;
    maxReviewersPerPr?: number;
  },
): Promise<PrPayoutPolicyRow | null> {
  const sponsorRef =
    Deno.env.get('PR_PAYOUT_SPONSOR_CIRCLE_WALLET_ID')?.trim() ||
    Deno.env.get('PR_PAYOUT_SPONSOR_WALLET_ID')?.trim() ||
    'unconfigured';

  const row: Record<string, unknown> = {
    repo_id: input.repoId,
    repo_full_name: input.repoFullName,
    sponsor_pool_ref: sponsorRef,
    per_pr_amount_usdc: input.perPrAmountUsdc,
    daily_cap_usdc: input.dailyCapUsdc ?? 50,
    budget_remaining_usdc: input.budgetRemainingUsdc ?? 100,
    active: input.active ?? true,
    updated_at: new Date().toISOString(),
  };
  if (input.bountyEnabled !== undefined) row.bounty_enabled = input.bountyEnabled;
  if (input.releasePoolUsdc !== undefined) row.release_pool_usdc = input.releasePoolUsdc;
  if (input.splitMode !== undefined) row.split_mode = input.splitMode;
  if (input.reviewAmountUsdc !== undefined) row.review_amount_usdc = input.reviewAmountUsdc;
  if (input.reviewMinChars !== undefined) row.review_min_chars = input.reviewMinChars;
  if (input.maxReviewersPerPr !== undefined) row.max_reviewers_per_pr = input.maxReviewersPerPr;

  const { data, error } = await client
    .from('pr_payout_policies')
    .upsert(row, { onConflict: 'repo_id' })
    .select('*')
    .single();

  if (error) {
    console.error('[pr-payout] upsert policy error:', error);
    return null;
  }
  return data as PrPayoutPolicyRow;
}

export async function syncClaimStatuses(deps: PrPayoutDeps): Promise<number> {
  const client = deps.getClient();
  const { zkSendAddress } = deps.getArcConfig();
  const { data: pending } = await client
    .from('github_pr_payouts')
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
        await updateReceipt(client, row.id, { claim_status: 'claimed' });
        updated++;
      }
    } catch {
      // ignore per-row errors
    }
  }
  return updated;
}

export function buildIdentityHash(platform: string, handle: string): `0x${string}` {
  return keccak256(toBytes(`${platform}:${handle}`));
}
