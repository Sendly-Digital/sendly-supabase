import { createPublicClient, fallback, http, type PublicClient } from 'npm:viem';

/** Public Arc Testnet RPC - safe fallback when Canteen proxy is unavailable. */
export const DEFAULT_ARC_RPC = 'https://rpc.testnet.arc.network';

/** Primary: Canteen proxy (`ARC_RPC_URL` or `RPC_URL` from arc-canteen login). Fallback: public Arc RPC. */
export function getArcRpcUrls(): string[] {
  const primary =
    Deno.env.get('ARC_RPC_URL')?.trim() || Deno.env.get('RPC_URL')?.trim();
  const fallbackUrl =
    Deno.env.get('ARC_RPC_FALLBACK_URL')?.trim() || DEFAULT_ARC_RPC;
  const urls = [primary, fallbackUrl].filter((u): u is string => Boolean(u));
  return [...new Set(urls)];
}

export function getArcRpcUrl(): string {
  return getArcRpcUrls()[0] ?? DEFAULT_ARC_RPC;
}

export function createArcTransport() {
  const urls = getArcRpcUrls();
  if (urls.length <= 1) return http(urls[0] ?? DEFAULT_ARC_RPC);
  return fallback(urls.map((url) => http(url)));
}

export function createArcPublicClient(): PublicClient {
  return createPublicClient({ transport: createArcTransport() });
}
