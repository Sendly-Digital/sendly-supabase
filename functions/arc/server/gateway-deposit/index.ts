// Supabase Edge Function: gateway-deposit
// Deploy to: supabase/functions/gateway-deposit/index.ts
// Handles USDC deposits into Circle Gateway unified balance via Circle developer wallets.

import { UnifiedBalanceKit } from "npm:@circle-fin/unified-balance-kit";
import { createCircleWalletsAdapter } from "npm:@circle-fin/adapter-circle-wallets";

const CIRCLE_API_KEY = Deno.env.get("CIRCLE_API_KEY") ?? "";
const CIRCLE_ENTITY_SECRET = Deno.env.get("CIRCLE_ENTITY_SECRET") ?? "";

const CHAIN_MAP: Record<string, string> = {
  "Arc Testnet": "Arc_Testnet",
  "Base Sepolia": "Base_Sepolia",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (!CIRCLE_API_KEY || !CIRCLE_ENTITY_SECRET) {
    return Response.json(
      { success: false, error: "Server configuration error: missing Circle API credentials" },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  try {
    const body = await req.json();
    const { walletAddress, chain, amount } = body;

    if (!walletAddress || !amount) {
      return Response.json(
        { success: false, error: `Missing required parameter: ${!walletAddress ? "walletAddress" : "amount"}` },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const sdkChain = CHAIN_MAP[chain];
    if (!sdkChain) {
      return Response.json(
        { success: false, error: `Unsupported chain: ${chain}. Supported: ${Object.keys(CHAIN_MAP).join(", ")}` },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const adapter = createCircleWalletsAdapter({
      apiKey: CIRCLE_API_KEY,
      entitySecret: CIRCLE_ENTITY_SECRET,
    });

    const kit = new UnifiedBalanceKit();

    const result = await kit.deposit({
      from: { adapter, chain: sdkChain, address: walletAddress },
      amount,
    });

    return Response.json(
      {
        success: true,
        data: {
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          amount: result.amount,
          chain: result.chain,
        },
      },
      { headers: { "Access-Control-Allow-Origin": "*" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("gateway-deposit error:", message);
    return Response.json(
      { success: false, error: message },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
});
