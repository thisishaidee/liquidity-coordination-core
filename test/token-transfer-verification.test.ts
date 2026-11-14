import { describe, expect, it } from "vitest";
import { verifyExactSplTokenTransfer, type SolanaTokenTransferTransaction } from "../src/token-transfer-verification";

const SOURCE = "SourceWallet11111111111111111111111111111";
const DESTINATION = "DestinationWallet1111111111111111111111";
const SOURCE_ATA = "SourceTokenAccount111111111111111111111";
const DESTINATION_ATA = "DestinationTokenAccount111111111111111";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "spl-token";

function tx(): SolanaTokenTransferTransaction {
  return {
    transaction: { message: {
      accountKeys: [
        { pubkey: SOURCE, signer: true },
        SOURCE_ATA,
        DESTINATION_ATA
      ],
      instructions: [{
        program: TOKEN_PROGRAM,
        parsed: { type: "transferChecked", info: {
          source: SOURCE_ATA, destination: DESTINATION_ATA, authority: SOURCE,
          mint: MINT, tokenAmount: { amount: "2500000", decimals: 6 }
        } }
      }]
    } },
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, owner: SOURCE, mint: MINT, uiTokenAmount: { amount: "5000000" } }],
      postTokenBalances: [
        { accountIndex: 1, owner: SOURCE, mint: MINT, uiTokenAmount: { amount: "2500000" } },
        { accountIndex: 2, owner: DESTINATION, mint: MINT, uiTokenAmount: { amount: "2500000" } }
      ]
    }
  };
}

const expected = { sourceOwner: SOURCE, destinationOwner: DESTINATION, mint: MINT, amountAtoms: 2500000n };

describe("exact SPL token funding-leg verification", () => {
  it("accepts the exact transfer between the registered owners", () => {
    expect(verifyExactSplTokenTransfer(tx(), expected).verified).toBe(true);
  });

  it("rejects a transfer from a different owner", () => {
    const value = tx();
    value.meta!.preTokenBalances![0].owner = "Attacker111111111111111111111111111111";
    value.meta!.postTokenBalances![0].owner = "Attacker111111111111111111111111111111";
    expect(verifyExactSplTokenTransfer(value, expected).verified).toBe(false);
  });

  it("rejects a wrong destination owner", () => {
    const value = tx();
    value.meta!.postTokenBalances![1].owner = "WrongDestination1111111111111111111111";
    expect(verifyExactSplTokenTransfer(value, expected).verified).toBe(false);
  });

  it("rejects a wrong mint", () => {
    const value = tx();
    value.meta!.postTokenBalances![1].mint = "WrongMint111111111111111111111111111111";
    expect(verifyExactSplTokenTransfer(value, expected).verified).toBe(false);
  });

  it("rejects an amount mismatch", () => {
    const value = tx();
    value.transaction!.message!.instructions![0].parsed!.info!.tokenAmount = { amount: "2499999" };
    expect(verifyExactSplTokenTransfer(value, expected).verified).toBe(false);
  });

  it("rejects a transfer without the registered wallet signature", () => {
    const value = tx();
    (value.transaction!.message!.accountKeys![0] as { signer: boolean }).signer = false;
    expect(verifyExactSplTokenTransfer(value, expected).verified).toBe(false);
  });

  it("rejects failed transactions", () => {
    const value = tx();
    value.meta!.err = { InstructionError: [0, "Custom"] };
    expect(verifyExactSplTokenTransfer(value, expected).verified).toBe(false);
  });

  it("rejects ambiguous transactions with multiple outgoing transfers", () => {
    const value = tx();
    value.transaction!.message!.instructions!.push(value.transaction!.message!.instructions![0]);
    expect(verifyExactSplTokenTransfer(value, expected).verified).toBe(false);
  });
});
