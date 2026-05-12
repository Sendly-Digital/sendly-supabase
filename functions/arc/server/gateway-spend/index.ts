// Supabase Edge Function: gateway-spend
// Deploy to: supabase/functions/gateway-spend/index.ts
// Transfers USDC from Gateway unified balance to a destination chain via Circle developer wallets.

import { UnifiedBalanceKit } from "npm:@circle-fin/unified-balance-kit";
import { createCircleWalletsAdapter } from "npm:@circle-fin/adapter-circle-wallets";

const CIRCLE_API_KEY = Deno.env.get("CIRCLE_API_KEY") ?? "";
const CIRCLE_ENTITY_SECRET = Deno.env.get("CIRCLE_ENTITY_SECRET") ?? "";

const BLOCKCHAIN_TO_SDK_CHAIN: Record<string, string> = {
  "ARC-TESTNET": "Arc_Testnet",
  "BASE-SEPOLIA": "Base_Sepolia",
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
      { success: false, error: "Server configuration error" },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  try {
    const body = await req.json();
    const { walletAddress, sourceBlockchain, destinationBlockchain, recipientAddress, amount } = body;

    if (!walletAddress || !amount || !recipientAddress) {
      return Response.json(
        { success: false, error: `Missing required parameter: ${!walletAddress ? "walletAddress" : !amount ? "amount" : "recipientAddress"}` },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const sourceChain = BLOCKCHAIN_TO_SDK_CHAIN[sourceBlockchain];
    const destChain = BLOCKCHAIN_TO_SDK_CHAIN[destinationBlockchain];

    if (!sourceChain) {
      return Response.json(
        { success: false, error: `Unsupported source blockchain: ${sourceBlockchain}` },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
    if (!destChain) {
      return Response.json(
        { success: false, error: `Unsupported destination blockchain: ${destinationBlockchain}` },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(recipientAddress)) {
      return Response.json(
        { success: false, error: "Invalid recipient address" },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const adapter = createCircleWalletsAdapter({
      apiKey: CIRCLE_API_KEY,
      entitySecret: CIRCLE_ENTITY_SECRET,
    });

    const kit = new UnifiedBalanceKit();

    const result = await kit.spend({
      from: { adapter, address: walletAddress, allocations: { amount, chain: sourceChain } },
      to: { chain: destChain, recipientAddress },
      amount,
    });

    return Response.json(
      {
        success: true,
        data: {
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          transferId: result.transferId,
          destinationChain: result.destinationChain,
          recipientAddress: result.recipientAddress,
          allocations: result.allocations,
        },
      },
      { headers: { "Access-Control-Allow-Origin": "*" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("gateway-spend error:", message);
    return Response.json(
      { success: false, error: message },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
});
