// Supabase Edge Function: gateway-balances
// Deploy to: supabase/functions/gateway-balances/index.ts
// Handles Gateway unified balance queries via Unified Balance Kit.

import "jsr:@std/dotenv/load";
import { UnifiedBalanceKit } from "@circle-fin/unified-balance-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";

const CIRCLE_API_KEY = Deno.env.get("CIRCLE_API_KEY");
const CIRCLE_ENTITY_SECRET = Deno.env.get("CIRCLE_ENTITY_SECRET");
const API_KEY = Deno.env.get("GATEWAY_API_KEY") || Deno.env.get("SUPABASE_ANON_KEY");

// Chain identifiers for testnet
const TESTNET_CHAINS = [
  "Arc_Testnet",
  "Base_Sepolia",
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
      },
    });
  }

  const apiKeyHeader = req.headers.get("x-api-key") || "";
  const authHeader = req.headers.get("Authorization") || "";
  if (apiKeyHeader !== API_KEY && !authHeader.startsWith("Bearer ")) {
    return Response.json(
      { success: false, error: "Unauthorized" },
      { status: 401, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  try {
    const body = await req.json();
    const { address } = body;

    if (!address) {
      return Response.json(
        { success: false, error: "address is required" },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    if (!CIRCLE_API_KEY || !CIRCLE_ENTITY_SECRET) {
      // Fallback: use address-only query (read-only, no adapter needed)
      const kit = new UnifiedBalanceKit();
      const balances = await kit.getBalances({
        sources: { address, chains: TESTNET_CHAINS },
        networkType: "testnet",
      });

      return Response.json(
        {
          success: true,
          data: {
            totalConfirmedBalance: balances.totalConfirmedBalance,
            breakdown: balances.breakdown.flatMap((account) =>
              account.breakdown.map((chain) => ({
                chain: chain.chain,
                confirmedBalance: chain.confirmedBalance,
              }))
            ),
          },
        },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    // With Circle API credentials, use adapter
    const adapter = createCircleWalletsAdapter({
      apiKey: CIRCLE_API_KEY,
      entitySecret: CIRCLE_ENTITY_SECRET,
    });

    const kit = new UnifiedBalanceKit();

    const balances = await kit.getBalances({
      sources: { adapter, chains: TESTNET_CHAINS },
      networkType: "testnet",
    });

    return Response.json(
      {
        success: true,
        data: {
          totalConfirmedBalance: balances.totalConfirmedBalance,
          breakdown: balances.breakdown.flatMap((account) =>
            account.breakdown.map((chain) => ({
              chain: chain.chain,
              confirmedBalance: chain.confirmedBalance,
            }))
          ),
        },
      },
      { headers: { "Access-Control-Allow-Origin": "*" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      { success: false, error: message },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
});
