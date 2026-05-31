/**
 * Arc Escrow — AI-Powered Work Validation + USDC Auto-Settlement
 *
 * Full ERC-8183 job lifecycle on Arc Testnet:
 *   1. Create Circle developer-controlled wallets (client + provider)
 *   2. Fund escrow with USDC
 *   3. Provider submits deliverable hash
 *   4. Claude AI evaluates the work
 *   5. Auto-settle (complete) or refund (reject) based on AI verdict
 *
 * Prerequisites:
 *   npm install @circle-fin/developer-controlled-wallets viem @anthropic-ai/sdk
 *   npm install --save-dev tsx typescript @types/node
 *
 * .env:
 *   CIRCLE_API_KEY=<your Circle API key>
 *   CIRCLE_ENTITY_SECRET=<your Circle entity secret>
 *   ANTHROPIC_API_KEY=<your Anthropic API key>
 */

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import Anthropic from "@anthropic-ai/sdk";
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { stdin as input, stdout as output } from "node:process";

// ── Constants ────────────────────────────────────────────────────────────────

const AGENTIC_COMMERCE_CONTRACT =
  "0x0747EEf0706327138c69792bF28Cd525089e4583" as Address;

const USDC_CONTRACT =
  "0x3600000000000000000000000000000000000000" as Address;

/** 5 USDC (6 decimals) */
const JOB_BUDGET = parseUnits("5", 6);

const STATUS_NAMES = [
  "Open",
  "Funded",
  "Submitted",
  "Completed",
  "Rejected",
  "Expired",
];

// ── ABI (minimal) ────────────────────────────────────────────────────────────

const agenticCommerceAbi = [
  {
    type: "function",
    name: "createJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider",  type: "address" },
      { name: "evaluator", type: "address" },
      { name: "expiredAt", type: "uint256" },
      { name: "description", type: "string" },
      { name: "hook",      type: "address"  },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setBudget",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",     type: "uint256" },
      { name: "amount",    type: "uint256" },
      { name: "optParams", type: "bytes"   },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",     type: "uint256" },
      { name: "optParams", type: "bytes"   },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",       type: "uint256"  },
      { name: "deliverable", type: "bytes32"  },
      { name: "optParams",   type: "bytes"    },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "complete",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",     type: "uint256"  },
      { name: "reason",    type: "bytes32"  },
      { name: "optParams", type: "bytes"    },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reject",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",     type: "uint256"  },
      { name: "reason",    type: "bytes32"  },
      { name: "optParams", type: "bytes"    },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id",          type: "uint256"  },
          { name: "client",      type: "address"  },
          { name: "provider",    type: "address"  },
          { name: "evaluator",   type: "address"  },
          { name: "description", type: "string"   },
          { name: "budget",      type: "uint256"  },
          { name: "expiredAt",   type: "uint256"  },
          { name: "status",      type: "uint8"    },
          { name: "hook",        type: "address"  },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "JobCreated",
    inputs: [
      { indexed: true,  name: "jobId",     type: "uint256" },
      { indexed: true,  name: "client",    type: "address" },
      { indexed: true,  name: "provider",  type: "address" },
      { indexed: false, name: "evaluator", type: "address" },
      { indexed: false, name: "expiredAt", type: "uint256" },
      { indexed: false, name: "hook",      type: "address" },
    ],
    anonymous: false,
  },
] as const;

// ── Clients ──────────────────────────────────────────────────────────────────

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(label: string, msg = "") {
  const prefix = label ? `\n── ${label} ──` : "";
  console.log(prefix + (msg ? `\n  ${msg}` : ""));
}

async function waitForTx(txId: string, label: string): Promise<Hex> {
  process.stdout.write(`  Waiting for ${label}`);
  for (let i = 0; i < 60; i++) {
    await delay(2000);
    const tx = await circleClient.getTransaction({ id: txId });
    const data = tx.data?.transaction;
    if (data?.state === "COMPLETE" && data.txHash) {
      const hash = data.txHash as Hex;
      const explorerUrl = arcTestnet.blockExplorers.default.url;
      console.log(` ✓\n  Tx: ${explorerUrl}/tx/${hash}`);
      return hash;
    }
    if (data?.state === "FAILED") throw new Error(`${label} failed onchain`);
    process.stdout.write(".");
  }
  throw new Error(`${label} timed out after 120s`);
}

async function extractJobId(txHash: Hex): Promise<bigint> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  for (const logEntry of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: agenticCommerceAbi,
        data: logEntry.data,
        topics: logEntry.topics,
      });
      if (decoded.eventName === "JobCreated") return decoded.args.jobId;
    } catch { continue; }
  }
  throw new Error("Could not parse JobCreated event");
}

async function getUsdcBalance(walletId: string): Promise<string> {
  const balances = await circleClient.getWalletTokenBalance({ id: walletId });
  const usdc = balances.data?.tokenBalances?.find(
    (b) => b.token?.symbol === "USDC"
  );
  return usdc?.amount ?? "0";
}

// ── AI Evaluator ─────────────────────────────────────────────────────────────

interface DeliverableInput {
  jobDescription: string;
  deliverableContent: string;
  budget: string;
}

interface AiVerdict {
  approved: boolean;
  score: number;        // 0–100
  summary: string;
  reasoning: string;
}

/**
 * Uses Claude to verify whether a deliverable meets the job requirements.
 * Returns a structured verdict that drives the on-chain settlement decision.
 */
async function aiEvaluateDeliverable(
  input: DeliverableInput
): Promise<AiVerdict> {
  log("AI Evaluator", "Sending deliverable to Claude for verification...");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are an impartial AI evaluator for a decentralized work marketplace built on Arc (an EVM blockchain). Your verdict will directly trigger on-chain USDC settlement or refund.

JOB DESCRIPTION:
${input.jobDescription}

ESCROW AMOUNT: ${input.budget} USDC

PROVIDER'S DELIVERABLE:
${input.deliverableContent}

Evaluate whether the deliverable satisfactorily fulfills the job description.

Respond ONLY with valid JSON (no markdown, no explanation outside the JSON):
{
  "approved": true | false,
  "score": <integer 0-100>,
  "summary": "<one sentence verdict>",
  "reasoning": "<2-3 sentences explaining your decision>"
}`,
      },
    ],
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  try {
    return JSON.parse(raw) as AiVerdict;
  } catch {
    // Fallback: try to extract JSON from the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as AiVerdict;
    throw new Error(`AI returned invalid JSON: ${raw}`);
  }
}

// ── Main Flow ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Arc Escrow — AI Work Validation + USDC      ║");
  console.log("║  ERC-8183 on Arc Testnet × Claude AI         ║");
  console.log("╚══════════════════════════════════════════════╝");

  // ── Step 1: Create wallets ────────────────────────────────────────────────
  log("Step 1: Create wallets");

  const walletSet = await circleClient.createWalletSet({
    name: "Arc Escrow AI Wallets",
  });

  const walletsResponse = await circleClient.createWallets({
    blockchains: ["ARC-TESTNET"],
    count: 2,
    walletSetId: walletSet.data?.walletSet?.id ?? "",
    accountType: "SCA",
  });

  const clientWallet   = walletsResponse.data?.wallets?.[0]!;
  const providerWallet = walletsResponse.data?.wallets?.[1]!;

  console.log(`  Client   (buyer/evaluator): ${clientWallet.address}`);
  console.log(`  Provider (worker/AI agent): ${providerWallet.address}`);

  // ── Step 2: Fund client wallet ────────────────────────────────────────────
  log("Step 2: Fund client wallet");
  console.log("  Visit https://faucet.circle.com and request testnet USDC for:");
  console.log(`  ${clientWallet.address}`);

  const rl = createInterface({ input, output });
  await rl.question("\n  Press Enter once the client wallet is funded... ");
  rl.close();

  // Bootstrap provider with 1 USDC for gas
  log("Step 2b: Transfer 1 USDC to provider for gas");
  const bootstrapTx = await circleClient.createTransaction({
    walletAddress: clientWallet.address!,
    blockchain: "ARC-TESTNET",
    tokenAddress: USDC_CONTRACT,
    destinationAddress: providerWallet.address!,
    amount: ["1"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  await waitForTx(bootstrapTx.data?.id!, "bootstrap provider wallet");

  // ── Step 3: Balances before ───────────────────────────────────────────────
  log("Step 3: Balances before job");
  const clientBefore   = await getUsdcBalance(clientWallet.id!);
  const providerBefore = await getUsdcBalance(providerWallet.id!);
  console.log(`  Client:   ${clientBefore} USDC`);
  console.log(`  Provider: ${providerBefore} USDC`);

  // ── Step 4: Create job ────────────────────────────────────────────────────
  log("Step 4: Create ERC-8183 job — createJob()");

  const now = await publicClient.getBlock();
  const expiredAt = now.timestamp + 3600n; // 1 hour from now

  const jobDescription =
    "Write a concise executive summary (150–200 words) explaining what Arc blockchain is, its key advantages for stablecoin payments, and why AI agents should use it for autonomous settlement. Output plain text only.";

  const createJobTx = await circleClient.createContractExecutionTransaction({
    walletAddress: clientWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "createJob(address,address,uint256,string,address)",
    abiParameters: [
      providerWallet.address!,
      clientWallet.address!,            // client is also evaluator
      expiredAt.toString(),
      jobDescription,
      "0x0000000000000000000000000000000000000000",
    ],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const createJobHash = await waitForTx(createJobTx.data?.id!, "create job");
  const jobId = await extractJobId(createJobHash);
  console.log(`  Job ID: ${jobId}`);
  console.log(`  Description: "${jobDescription.slice(0, 60)}..."`);

  // ── Step 5: Set budget ────────────────────────────────────────────────────
  log("Step 5: Set budget — setBudget()");
  console.log(`  Budget: ${formatUnits(JOB_BUDGET, 6)} USDC`);

  const setBudgetTx = await circleClient.createContractExecutionTransaction({
    walletAddress: providerWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "setBudget(uint256,uint256,bytes)",
    abiParameters: [jobId.toString(), JOB_BUDGET.toString(), "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  await waitForTx(setBudgetTx.data?.id!, "set budget");

  // ── Step 6: Approve USDC + fund escrow ───────────────────────────────────
  log("Step 6: Approve USDC + fund escrow — approve() + fund()");

  const approveTx = await circleClient.createContractExecutionTransaction({
    walletAddress: clientWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: USDC_CONTRACT,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [AGENTIC_COMMERCE_CONTRACT, JOB_BUDGET.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  await waitForTx(approveTx.data?.id!, "approve USDC");

  const fundTx = await circleClient.createContractExecutionTransaction({
    walletAddress: clientWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "fund(uint256,bytes)",
    abiParameters: [jobId.toString(), "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  await waitForTx(fundTx.data?.id!, "fund escrow");
  console.log("  Job state: Funded ✓  USDC locked in escrow");

  // ── Step 7: Provider submits deliverable ──────────────────────────────────
  log("Step 7: Provider submits deliverable — submit()");

  /**
   * In production this deliverable comes from your AI agent or worker.
   * Here we simulate it inline for the demo.
   */
  const deliverableContent = `Arc is a purpose-built blockchain for stablecoin finance, combining sub-second deterministic finality with USDC as its native gas token. Unlike traditional EVM chains where gas is paid in volatile cryptocurrencies, Arc lets developers and agents transact entirely in stable value — no ETH float required.

For AI agents, Arc's ERC-8183 standard defines a programmable job lifecycle: create, fund, submit, evaluate, and settle — all onchain. Escrow is held in USDC until an evaluator (human or AI) confirms the work meets requirements, at which point funds release automatically. Disputes can trigger refunds without manual intervention.

Arc's native compliance integrations (Elliptic, TRM Labs) and protocol-level USDC blocklist enforcement make it suitable for regulated agentic workflows. With standard EVM tooling (viem, ethers.js, web3.py) and Circle Developer Controlled Wallets, AI agents can autonomously register identity, accept jobs, deliver work, and collect payment — closing the loop on fully autonomous value exchange.`;

  console.log("  Deliverable preview:");
  console.log(`  "${deliverableContent.slice(0, 100)}..."`);

  const deliverableHash = keccak256(toHex(deliverableContent));
  console.log(`  Hash: ${deliverableHash}`);

  const submitTx = await circleClient.createContractExecutionTransaction({
    walletAddress: providerWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "submit(uint256,bytes32,bytes)",
    abiParameters: [jobId.toString(), deliverableHash, "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  await waitForTx(submitTx.data?.id!, "submit deliverable");
  console.log("  Job state: Submitted ✓");

  // ── Step 8: Claude AI evaluates the work ─────────────────────────────────
  log("Step 8: AI Evaluation (Claude)");

  const verdict = await aiEvaluateDeliverable({
    jobDescription,
    deliverableContent,
    budget: formatUnits(JOB_BUDGET, 6),
  });

  console.log(`\n  ┌─ AI Verdict ────────────────────────────────┐`);
  console.log(`  │  Decision : ${verdict.approved ? "✅ APPROVE — release USDC" : "❌ REJECT  — refund client"}`);
  console.log(`  │  Score    : ${verdict.score}/100`);
  console.log(`  │  Summary  : ${verdict.summary}`);
  console.log(`  │  Reasoning: ${verdict.reasoning}`);
  console.log(`  └────────────────────────────────────────────┘`);

  // ── Step 9: On-chain settlement based on AI verdict ───────────────────────
  if (verdict.approved) {
    log("Step 9: AI approved — complete() → USDC released to provider");

    const reasonHash = keccak256(
      toHex(`approved:score=${verdict.score}:${verdict.summary}`)
    );

    const completeTx = await circleClient.createContractExecutionTransaction({
      walletAddress: clientWallet.address!,
      blockchain: "ARC-TESTNET",
      contractAddress: AGENTIC_COMMERCE_CONTRACT,
      abiFunctionSignature: "complete(uint256,bytes32,bytes)",
      abiParameters: [jobId.toString(), reasonHash, "0x"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    await waitForTx(completeTx.data?.id!, "complete job");
    console.log("  Job state: Completed ✓  Provider paid 5 USDC");

  } else {
    log("Step 9: AI rejected — reject() → USDC refunded to client");

    const reasonHash = keccak256(
      toHex(`rejected:score=${verdict.score}:${verdict.summary}`)
    );

    const rejectTx = await circleClient.createContractExecutionTransaction({
      walletAddress: clientWallet.address!,
      blockchain: "ARC-TESTNET",
      contractAddress: AGENTIC_COMMERCE_CONTRACT,
      abiFunctionSignature: "reject(uint256,bytes32,bytes)",
      abiParameters: [jobId.toString(), reasonHash, "0x"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    await waitForTx(rejectTx.data?.id!, "reject job");
    console.log("  Job state: Rejected ✓  Client refunded 5 USDC");
  }

  // ── Step 10: Final state ──────────────────────────────────────────────────
  log("Step 10: Final state");

  const job = await publicClient.readContract({
    address: AGENTIC_COMMERCE_CONTRACT,
    abi: agenticCommerceAbi,
    functionName: "getJob",
    args: [jobId],
  });

  const clientAfter   = await getUsdcBalance(clientWallet.id!);
  const providerAfter = await getUsdcBalance(providerWallet.id!);

  console.log(`\n  ┌─ Summary ───────────────────────────────────┐`);
  console.log(`  │  Job #${jobId}  Status: ${STATUS_NAMES[Number(job.status)]}`);
  console.log(`  │  Budget: ${formatUnits(job.budget, 6)} USDC`);
  console.log(`  │  Client balance:   ${clientBefore} → ${clientAfter} USDC`);
  console.log(`  │  Provider balance: ${providerBefore} → ${providerAfter} USDC`);
  console.log(`  │  Deliverable hash: ${deliverableHash.slice(0, 18)}...`);
  console.log(`  │  AI Score: ${verdict.score}/100`);
  console.log(`  └────────────────────────────────────────────┘`);

  const explorerBase = arcTestnet.blockExplorers.default.url;
  console.log(`\n  View on Arc Testnet Explorer:`);
  console.log(`  ${explorerBase}/address/${AGENTIC_COMMERCE_CONTRACT}`);
}

main().catch((err) => {
  console.error("\n❌ Error:", err?.message ?? err);
  process.exit(1);
});
