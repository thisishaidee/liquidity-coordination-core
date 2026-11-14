import { describe, expect, it } from "vitest";
import {
  verifySolanaTokenTransfer,
  type SolanaPaymentTransaction,
  type ExpectedSolanaTokenTransfer
} from "../src/payment-settlement";

const SIGNATURE = "5".repeat(64);
const SOURCE = "SourceWallet111111111111111111111111111";
const DESTINATION = "DestinationWallet111111111111111111111";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOURCE_ATA = "SourceTokenAccount111111111111111111111";
const DESTINATION_ATA = "DestinationTokenAccount111111111111111111";

function fixture(): SolanaPaymentTransaction {
  return {
    slot: 123456,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: [
          { pubkey: SOURCE, signer: true, writable: true },
          { pubkey: SOURCE_ATA, signer: false, writable: true },
          { pubkey: DESTINATION, signer: false, writable: false },
          { pubkey: DESTINATION_ATA, signer: false, writable: true }
        ],
        instructions: [{
          program: "spl-token",
          parsed: {
            type: "transferChecked",
            info: {
              source: SOURCE_ATA,
              destination: DESTINATION_ATA,
              mint: MINT,
              authority: SOURCE,
              tokenAmount: { amount: "1000000", decimals: 6, uiAmount: 1 }
            }
          }
        }]
      }
    },
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 1, owner: SOURCE, mint: MINT, uiTokenAmount: { amount: "9000000", decimals: 6 } },
        { accountIndex: 3, owner: DESTINATION, mint: MINT, uiTokenAmount: { amount: "1000000", decimals: 6 } }
      ],
      postTokenBalances: [
        { accountIndex: 1, owner: SOURCE, mint: MINT, uiTokenAmount: { amount: "8000000", decimals: 6 } },
        { accountIndex: 3, owner: DESTINATION, mint: MINT, uiTokenAmount: { amount: "2000000", decimals: 6 } }
      ],
      innerInstructions: []
    }
  };
}

const expected: ExpectedSolanaTokenTransfer = {
  signature: SIGNATURE,
  sourceWalletAddress: SOURCE,
  destinationOwnerAddress: DESTINATION,
  mint: MINT,
  amountAtoms: "1000000",
  decimals: 6
};

describe("verifySolanaTokenTransfer", () => {
  it("verifies the exact finalized token transfer and both balance deltas", () => {
    const result = verifySolanaTokenTransfer(fixture(), expected);
    expect(result.verified).toBe(true);
    expect(result.amountAtoms).toBe("1000000");
    expect(result.sourceTokenAccount).toBe(SOURCE_ATA);
    expect(result.destinationTokenAccount).toBe(DESTINATION_ATA);
    expect(result.slot).toBe(123456);
  });

  it("rejects a transaction that does not contain the submitted signature", () => {
    const tx = fixture();
    tx.transaction!.signatures = ["4".repeat(64)];
    expect(verifySolanaTokenTransfer(tx, expected).reason).toContain("submitted signature");
  });

  it("requires the registered source wallet to be a signer", () => {
    const tx = fixture();
    (tx.transaction!.message!.accountKeys![0] as { signer: boolean }).signer = false;
    expect(verifySolanaTokenTransfer(tx, expected).reason).toContain("did not sign");
  });

  it("rejects a different token recipient owner", () => {
    expect(verifySolanaTokenTransfer(fixture(), {
      ...expected, destinationOwnerAddress: "AnotherRecipient111111111111111111111"
    }).reason).toContain("balance metadata");
  });

  it("rejects a different mint in the transfer instruction", () => {
    const tx = fixture();
    tx.transaction!.message!.instructions![0].parsed!.info!.mint = "So11111111111111111111111111111111111111112";
    expect(verifySolanaTokenTransfer(tx, expected).reason).toContain("mint or amount");
  });

  it("rejects an instruction amount that differs from the approved amount", () => {
    const tx = fixture();
    (tx.transaction!.message!.instructions![0].parsed!.info!.tokenAmount as { amount: string }).amount = "999999";
    expect(verifySolanaTokenTransfer(tx, expected).reason).toContain("mint or amount");
  });

  it("rejects token balance deltas that do not reconcile exactly", () => {
    const tx = fixture();
    tx.meta!.postTokenBalances![1].uiTokenAmount!.amount = "1999999";
    expect(verifySolanaTokenTransfer(tx, expected).reason).toContain("do not exactly match");
  });

  it("rejects more than one token transfer in the transaction", () => {
    const tx = fixture();
    tx.transaction!.message!.instructions!.push(tx.transaction!.message!.instructions![0]);
    expect(verifySolanaTokenTransfer(tx, expected).reason).toContain("exactly one");
  });

  it("rejects unapproved top-level program instructions", () => {
    const tx = fixture();
    tx.transaction!.message!.instructions!.push({ program: "unknown-program", parsed: { type: "execute", info: {} } });
    expect(verifySolanaTokenTransfer(tx, expected).reason).toContain("unapproved top-level");
  });

  it("accepts an associated-token account created for the approved recipient", () => {
    const tx = fixture();
    tx.meta!.preTokenBalances = tx.meta!.preTokenBalances!.filter(row => row.accountIndex !== 3);
    tx.transaction!.message!.instructions!.unshift({
      program: "spl-associated-token-account",
      parsed: { type: "createIdempotent", info: { account: DESTINATION_ATA, wallet: DESTINATION, mint: MINT } }
    });
    tx.meta!.innerInstructions = [{ instructions: [
      { program: "system", parsed: { type: "createAccount", info: { source: SOURCE, newAccount: DESTINATION_ATA, lamports: 2039280, space: 165, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } } },
      { program: "spl-token", parsed: { type: "initializeAccount3", info: { account: DESTINATION_ATA, mint: MINT, owner: DESTINATION } } }
    ] }];
    expect(verifySolanaTokenTransfer(tx, expected).verified).toBe(true);
  });

  it("rejects unapproved inner program instructions", () => {
    const tx = fixture();
    tx.meta!.innerInstructions = [{ instructions: [{ program: "unknown-program", parsed: { type: "execute", info: {} } }] }];
    expect(verifySolanaTokenTransfer(tx, expected).reason).toContain("unapproved inner");
  });
  it("rejects a failed or non-finalized transaction", () => {
    const failed = fixture();
    failed.meta!.err = { InstructionError: [0, "Custom"] };
    expect(verifySolanaTokenTransfer(failed, expected).reason).toContain("execution error");
    const noSlot = fixture();
    delete noSlot.slot;
    expect(verifySolanaTokenTransfer(noSlot, expected).reason).toContain("slot");
  });
});
