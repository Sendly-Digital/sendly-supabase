import { assertEquals, assert } from 'jsr:@std/assert';
import { computeRaidAmount } from './raidPayout.ts';
import { verifyTwitchWebhookHmac, extractVerificationChallenge } from './twitchWebhook.ts';
import {
  buildTwitchUidIdentity,
  generateTwitchUidHash,
  twitchUidHandleSegment,
} from './twitchIdentity.ts';
import type { TwitchPolicyRow } from './twitchPayoutCore.ts';

function mockPolicy(overrides: Partial<TwitchPolicyRow> = {}): TwitchPolicyRow {
  return {
    id: 'policy-1',
    campaign_id: 'camp-1',
    event_type: 'channel.raid',
    payout_kind: 'raid',
    min_viewers: 5,
    rate_per_viewer_usdc: '0.01',
    max_per_event_usdc: '2',
    max_per_day_usdc: '10',
    allowlist_json: null,
    require_approval: false,
    enabled: true,
    ...overrides,
  };
}

Deno.test('computeRaidAmount: below min_viewers skips', () => {
  const result = computeRaidAmount(3, mockPolicy());
  assertEquals(result.amount, 0);
  assertEquals(result.skipReason, 'below_min_viewers');
});

Deno.test('computeRaidAmount: min(viewers * rate, max_per_event)', () => {
  const result = computeRaidAmount(100, mockPolicy());
  assertEquals(result.amount, 2);
  assertEquals(result.skipReason, undefined);
});

Deno.test('computeRaidAmount: viewers * rate when under cap', () => {
  const result = computeRaidAmount(50, mockPolicy());
  assertEquals(result.amount, 0.5);
});

Deno.test('computeRaidAmount: zero rate skips', () => {
  const result = computeRaidAmount(10, mockPolicy({ rate_per_viewer_usdc: '0' }));
  assertEquals(result.amount, 0);
  assertEquals(result.skipReason, 'zero_amount');
});

Deno.test('twitch uid identity hash matches paySocialIdentity segment', () => {
  const userId = '12345678';
  assertEquals(buildTwitchUidIdentity(userId), 'twitch:uid:12345678');
  assertEquals(twitchUidHandleSegment(userId), 'uid:12345678');
  const hash = generateTwitchUidHash(userId);
  assert(hash.startsWith('0x'));
  assertEquals(hash.length, 66);
});

Deno.test('verifyTwitchWebhookHmac accepts valid signature', async () => {
  const secret = 'test-eventsub-secret';
  const messageId = 'msg-abc';
  const timestamp = new Date().toISOString();
  const body = '{"subscription":{"type":"channel.raid"},"event":{"viewers":10}}';

  const message = messageId + timestamp + body;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const signature =
    'sha256=' +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  const ok = await verifyTwitchWebhookHmac(secret, messageId, timestamp, body, signature);
  assertEquals(ok, true);
});

Deno.test('verifyTwitchWebhookHmac rejects tampered body', async () => {
  const secret = 'test-eventsub-secret';
  const messageId = 'msg-abc';
  const timestamp = new Date().toISOString();
  const body = '{"subscription":{"type":"channel.raid"}}';

  const ok = await verifyTwitchWebhookHmac(
    secret,
    messageId,
    timestamp,
    body,
    'sha256=deadbeef',
  );
  assertEquals(ok, false);
});

Deno.test('extractVerificationChallenge returns challenge string', () => {
  assertEquals(
    extractVerificationChallenge('{"challenge":"abc123","subscription":{"type":"channel.raid"}}'),
    'abc123',
  );
  assertEquals(extractVerificationChallenge('not-json'), null);
});
