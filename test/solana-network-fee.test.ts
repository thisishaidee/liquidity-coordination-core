import { describe, expect, it } from "vitest";
import { verifySolanaNetworkFee } from "../src/solana-network-fee";

describe("finalized Solana network fee verification", () => {
  const payer = "FeePayer111111111111111111111111111111111";

  it("accepts the registered fee payer when the actual fee is within the hold", () => {
    expect(verifySolanaNetworkFee({
      meta: { fee: 5000 },
      transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }] } }
    }, payer, "10000")).toEqual({ verified: true, actualFeeLamports: "5000" });
  });

  it("rejects account-key representations that do not prove the fee payer signed", () => {
    expect(verifySolanaNetworkFee({
      meta: { fee: 0 }, transaction: { message: { accountKeys: [{ pubkey: payer, signer: false }] } }
    }, payer, "0")).toEqual({ verified: false, reason: "Finalized transaction fee payer is not the registered business wallet with a verified transaction signature." });
    expect(verifySolanaNetworkFee({
      meta: { fee: 0 }, transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }] } }
    }, payer, "0").verified).toBe(false);
  });

  it("rejects a different fee payer", () => {
    const result = verifySolanaNetworkFee({
      meta: { fee: 5000 }, transaction: { message: { accountKeys: [{ pubkey: "OtherPayer", signer: true }] } }
    }, payer, "10000");
    expect(result.verified).toBe(false);
  });

  it("rejects fees above the immutable cap", () => {
    const result = verifySolanaNetworkFee({
      meta: { fee: 10001 }, transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }] } }
    }, payer, "10000");
    expect(result).toEqual({ verified: false, reason: "Finalized transaction network fee exceeds the approved fee cap." });
  });

  it.each([undefined, null, "5000", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed network fee values: %s",
    fee => {
      const result = verifySolanaNetworkFee({
        meta: { fee }, transaction: { message: { accountKeys: [payer] } }
      }, payer, "10000");
      expect(result.verified).toBe(false);
    }
  );

  it("rejects malformed or oversized fee caps", () => {
    expect(verifySolanaNetworkFee({ meta: { fee: 1 }, transaction: { message: { accountKeys: [payer] } } }, payer, "01").verified).toBe(false);
    expect(verifySolanaNetworkFee({ meta: { fee: 1 }, transaction: { message: { accountKeys: [payer] } } }, payer, "9223372036854775808").verified).toBe(false);
  });
});
