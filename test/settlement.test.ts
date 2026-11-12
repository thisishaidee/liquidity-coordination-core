import { describe, expect, it } from "vitest";
import { verifySolSourceDebit, type SolanaSettlementTransaction } from "../src/settlement";

const WALLET = "Wallet111111111111111111111111111111111111";
const ATA = "TokenAccount111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function transaction(overrides: Partial<SolanaSettlementTransaction> = {}): SolanaSettlementTransaction {
  return {
    transaction: {
      message: {
        accountKeys: [
          { pubkey: WALLET, signer: true, writable: true },
          { pubkey: ATA, signer: false, writable: true }
        ],
        instructions: []
      }
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [1_000_000_000, 0],
      postBalances: [897_955_720, 2_039_280],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 1, owner: WALLET, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }],
      innerInstructions: [{
        instructions: [{
          program: "system",
          parsed: {
            type: "createAccount",
            info: { source: WALLET, newAccount: ATA, lamports: 2_039_280, space: 165, owner: TOKEN_PROGRAM }
          }
        }]
      }]
    },
    ...overrides
  };
}

describe("finalized SOL source debit reconciliation", () => {
  it("accepts exact quoted input plus wallet-paid network fee and evidenced token-account rent", () => {
    const result = verifySolSourceDebit(transaction(), WALLET, 100_000_000n);
    expect(result.verified).toBe(true);
    expect(result.actualDebitAtoms).toBe(100_000_000n + 5_000n + 2_039_280n);
  });

  it("rejects an additional unexplained SOL transfer", () => {
    const tx = transaction();
    tx.meta!.postBalances![0] -= 1_000_000;
    const result = verifySolSourceDebit(tx, WALLET, 100_000_000n);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("exceeds");
  });

  it("rejects a debit below the quoted input", () => {
    const tx = transaction();
    tx.meta!.postBalances![0] += 1;
    expect(verifySolSourceDebit(tx, WALLET, 100_000_000n).verified).toBe(false);
  });

  it("does not grant a rent allowance for an unrelated or non-owned account", () => {
    const tx = transaction();
    tx.meta!.postTokenBalances![0].owner = "AnotherWallet1111111111111111111111111111";
    expect(verifySolSourceDebit(tx, WALLET, 100_000_000n).verified).toBe(false);
  });

  it("rejects a transaction without the registered wallet signature", () => {
    const tx = transaction();
    (tx.transaction!.message!.accountKeys![0] as { signer: boolean }).signer = false;
    expect(verifySolSourceDebit(tx, WALLET, 100_000_000n).verified).toBe(false);
  });

  it("rejects incomplete native balance metadata", () => {
    const tx = transaction();
    tx.meta!.postBalances = [];
    expect(verifySolSourceDebit(tx, WALLET, 100_000_000n).verified).toBe(false);
  });

  it("does not charge the registered wallet for a sponsor-paid network fee", () => {
    const tx = transaction();
    tx.transaction!.message!.accountKeys!.unshift({ pubkey: "Sponsor11111111111111111111111111111111", signer: true });
    tx.meta!.preBalances!.unshift(5_000_000);
    tx.meta!.postBalances!.unshift(4_995_000);
    tx.meta!.preBalances![1] = 1_000_000_000;
    tx.meta!.postBalances![1] = 897_960_720;
    tx.meta!.preBalances![2] = 0;
    tx.meta!.postBalances![2] = 2_039_280;
    tx.meta!.postTokenBalances![0].accountIndex = 2;
    expect(verifySolSourceDebit(tx, WALLET, 100_000_000n).verified).toBe(true);
  });
});
