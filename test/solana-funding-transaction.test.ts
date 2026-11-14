import { address } from "@solana/kit";
import {
  AccountState,
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token";
import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { buildUsdcFundingTransaction } from "../src/solana-funding-transaction";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOURCE = "11111111111111111111111111111111";
const DESTINATION = "Vote111111111111111111111111111111111111111";
const FEE_PAYER = "Stake11111111111111111111111111111111111111";
const BLOCKHASH = "11111111111111111111111111111111";
const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ADDRESS);

const mintData = getMintEncoder().encode({
  mintAuthority: null,
  supply: 1_000_000_000n,
  decimals: 6,
  isInitialized: true,
  freezeAuthority: null
});

function tokenData(owner: string, amount: bigint, mint = MINT) {
  return getTokenEncoder().encode({
    mint: address(mint),
    owner: address(owner),
    amount,
    delegate: null,
    state: AccountState.Initialized,
    isNative: null,
    delegatedAmount: 0n,
    closeAuthority: null
  });
}

async function mockConnection(options: {
  sourceAmount?: bigint;
  sourceOwner?: string;
  sourceMint?: string;
  destinationOwner?: string;
  destinationMint?: string;
  missingSource?: boolean;
  missingDestination?: boolean;
  fee?: number | null;
  feePayerBalance?: number;
} = {}) {
  const [sourceAta] = await findAssociatedTokenPda({
    mint: address(MINT), owner: address(SOURCE), tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  const [destinationAta] = await findAssociatedTokenPda({
    mint: address(MINT), owner: address(DESTINATION), tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  const mintKey = new PublicKey(MINT);
  const sourceKey = new PublicKey(sourceAta);
  const destinationKey = new PublicKey(destinationAta);
  const accountInfo = (data: Uint8Array) => ({
    data,
    executable: false,
    lamports: 2_039_280,
    owner: TOKEN_PROGRAM,
    rentEpoch: 0
  });
  const getAccountInfo = vi.fn(async (key: PublicKey) => {
    if (key.equals(mintKey)) return accountInfo(new Uint8Array(mintData)) as never;
    if (key.equals(sourceKey)) {
      if (options.missingSource) return null;
      return accountInfo(new Uint8Array(tokenData(options.sourceOwner ?? SOURCE, options.sourceAmount ?? 10_000_000n, options.sourceMint ?? MINT))) as never;
    }
    if (key.equals(destinationKey)) {
      if (options.missingDestination) return null;
      return accountInfo(new Uint8Array(tokenData(options.destinationOwner ?? DESTINATION, 0n, options.destinationMint ?? MINT))) as never;
    }
    return null;
  });
  const connection = {
    getAccountInfo,
    getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 99 })),
    getFeeForMessage: vi.fn(async () => ({ value: options.fee === undefined ? 5_000 : options.fee })),
    getBalance: vi.fn(async () => options.feePayerBalance ?? 1_000_000)
  } as unknown as Connection;
  return { connection, sourceAta, destinationAta, getAccountInfo };
}

const baseInput = {
  rpcUrl: "https://rpc.example.test",
  mintAddress: MINT,
  sourceWalletAddress: SOURCE,
  destinationOwnerAddress: DESTINATION,
  feePayerAddress: FEE_PAYER,
  amountAtoms: "5000000",
  maximumFeeLamports: "5000",
  remainingAggregateFeeLamports: "10000"
};

describe("buildUsdcFundingTransaction", () => {
  it("builds an unsigned checked USDC transfer with both required signers", async () => {
    const { connection, sourceAta, destinationAta } = await mockConnection();
    const result = await buildUsdcFundingTransaction(baseInput, connection);

    expect(result.transactionBase64.length).toBeGreaterThan(80);
    expect(result.messageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceTokenAccount).toBe(sourceAta);
    expect(result.destinationTokenAccount).toBe(destinationAta);
    expect(result.estimatedFeeLamports).toBe("5000");
    expect(result.requiredSigners).toEqual([FEE_PAYER, SOURCE]);
    expect(result.amountAtoms).toBe("5000000");
    expect(result.decimals).toBe(6);
  });

  it("deduplicates the signer list when the fee payer is the source owner", async () => {
    const { connection } = await mockConnection();
    const result = await buildUsdcFundingTransaction({
      ...baseInput,
      feePayerAddress: SOURCE
    }, connection);
    expect(result.requiredSigners).toEqual([SOURCE]);
  });

  it("rejects a missing recipient ATA rather than spending unreserved rent", async () => {
    const { connection } = await mockConnection({ missingDestination: true });
    await expect(buildUsdcFundingTransaction(baseInput, connection))
      .rejects.toThrow("will not spend unbudgeted rent");
  });

  it("rejects a missing source ATA", async () => {
    const { connection } = await mockConnection({ missingSource: true });
    await expect(buildUsdcFundingTransaction(baseInput, connection))
      .rejects.toThrow("does not have its canonical USDC associated token account");
  });

  it("rejects a source token account owned by another wallet", async () => {
    const { connection } = await mockConnection({ sourceOwner: DESTINATION });
    await expect(buildUsdcFundingTransaction(baseInput, connection))
      .rejects.toThrow("Source token account owner");
  });

  it("rejects a source token account for a different mint", async () => {
    const { connection } = await mockConnection({ sourceMint: "So11111111111111111111111111111111111111112" });
    await expect(buildUsdcFundingTransaction(baseInput, connection))
      .rejects.toThrow("Source token account owner");
  });

  it("rejects a fee estimate above either approved fee limit", async () => {
    const { connection } = await mockConnection({ fee: 5001 });
    await expect(buildUsdcFundingTransaction(baseInput, connection))
      .rejects.toThrow("exceeds the approved");
    const { connection: aggregateConnection } = await mockConnection({ fee: 4000 });
    await expect(buildUsdcFundingTransaction({
      ...baseInput,
      remainingAggregateFeeLamports: "3999"
    }, aggregateConnection)).rejects.toThrow("exceeds the approved");
  });

  it("rejects when the fee payer lacks finalized SOL for the estimated fee", async () => {
    const { connection } = await mockConnection({ feePayerBalance: 4999 });
    await expect(buildUsdcFundingTransaction(baseInput, connection))
      .rejects.toThrow("does not have enough finalized SOL");
  });
});
