import { describe, expect, it } from "vitest";
import {
  parseHermesPaymentPayload,
  parseHermesPaymentReceipt,
  parseHermesPaymentRequirement,
  verifyHermesPaymentTransaction
} from "../src/x402";

function b64(value: unknown): string {
  return btoa(JSON.stringify(value));
}

const requirement = {
  x402Version: 1,
  accepts: [{
    scheme: "exact",
    network: "solana",
    maxAmountRequired: "3007",
    resource: "https://hermes.swap.io/v1/swap/quote",
    payTo: "BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    maxTimeoutSeconds: 60,
    extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" }
  }, {
    scheme: "exact", network: "base", maxAmountRequired: "3007",
    resource: "https://hermes.swap.io/v1/swap/quote", payTo: "0xC22f661733B85C1349F7C83EE0B2BCF3234603dE"
  }]
};

describe("Hermes x402 V1 challenge parsing", () => {
  it("selects the exact Solana USDC requirement rather than the Base option", () => {
    const result = parseHermesPaymentRequirement(JSON.stringify(requirement), "/v1/swap/quote");
    expect(result?.network).toBe("solana");
    expect(result?.maxAmountRequired).toBe("3007");
    expect(result?.feePayer).toBe("2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4");
  });

  it("rejects a mismatched resource or unsupported asset", () => {
    expect(parseHermesPaymentRequirement(JSON.stringify(requirement), "/v1/swap/build-tx")).toBeNull();
    const altered = structuredClone(requirement);
    altered.accepts[0].asset = "wrong";
    expect(parseHermesPaymentRequirement(JSON.stringify(altered), "/v1/swap/quote")).toBeNull();
  });

  it("rejects zero or malformed payment amounts", () => {
    const altered = structuredClone(requirement);
    altered.accepts[0].maxAmountRequired = "0";
    expect(parseHermesPaymentRequirement(JSON.stringify(altered), "/v1/swap/quote")).toBeNull();
  });
});

describe("Hermes x402 payment payload and receipt", () => {
  it("accepts the documented V1 Solana transaction envelope", () => {
    const result = parseHermesPaymentPayload(b64({
      x402Version: 1, scheme: "exact", network: "solana",
      payload: { transaction: "A".repeat(120) }
    }));
    expect(result?.transaction).toBe("A".repeat(120));
  });

  it("rejects unsupported schemes and networks", () => {
    expect(parseHermesPaymentPayload(b64({
      x402Version: 1, scheme: "upto", network: "solana", payload: { transaction: "A".repeat(120) }
    }))).toBeNull();
    expect(parseHermesPaymentPayload(b64({
      x402Version: 1, scheme: "exact", network: "base", payload: { transaction: "A".repeat(120) }
    }))).toBeNull();
  });

  it("accepts a successful Solana settlement receipt", () => {
    const result = parseHermesPaymentReceipt(b64({
      success: true,
      transaction: "WZFi6CridBtDzatV7vScyoj723EVzZ3tbHqsGVPf7dzzJpsq7z4f7bFAbLG2NCi5vuKAP63BHfEZWEjiSoLdLvE",
      network: "solana",
      payer: "BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD"
    }));
    expect(result?.success).toBe(true);
  });

  it("rejects failed, malformed or non-Solana receipts", () => {
    expect(parseHermesPaymentReceipt(b64({ success: false, transaction: "WZFi6CridBtDzatV7vScyoj723EVzZ3tbHqsGVPf7dzzJpsq7z4f7bFAbLG2NCi5vuKAP63BHfEZWEjiSoLdLvE", network: "solana" }))).toBeNull();
    expect(parseHermesPaymentReceipt(b64({ success: true, transaction: "bad", network: "solana" }))).toBeNull();
    expect(parseHermesPaymentReceipt(b64({ success: true, transaction: "WZFi6CridBtDzatV7vScyoj723EVzZ3tbHqsGVPf7dzzJpsq7z4f7bFAbLG2NCi5vuKAP63BHfEZWEjiSoLdLvE", network: "base" }))).toBeNull();
  });
});

const payerAddress = "Payer111111111111111111111111111111111111";
const feePayerAddress = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const payToAddress = "BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD";
const sourceAta = "SourceAta111111111111111111111111111111111";
const destinationAta = "DestinationAta111111111111111111111111111111";

function settledTransaction(overrides: Record<string, unknown> = {}) {
  return {
    transaction: {
      message: {
        accountKeys: [
          { pubkey: feePayerAddress, signer: true },
          { pubkey: payerAddress, signer: true },
          { pubkey: sourceAta, signer: false },
          { pubkey: destinationAta, signer: false }
        ],
        instructions: [{
          program: "spl-token",
          parsed: {
            type: "transferChecked",
            info: {
              source: sourceAta,
              destination: destinationAta,
              authority: payerAddress,
              mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              tokenAmount: { amount: "3007", decimals: 6 }
            }
          }
        }]
      }
    },
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 2, owner: payerAddress, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
      ],
      postTokenBalances: [
        { accountIndex: 3, owner: payToAddress, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
      ]
    },
    ...overrides
  };
}

describe("on-chain Hermes payment receipt verification", () => {
  const req = parseHermesPaymentRequirement(JSON.stringify(requirement), "/v1/swap/quote")!;

  it("requires the exact USDC transfer, payer, recipient and advertised facilitator", async () => {
    const { verifyHermesPaymentTransaction } = await import("../src/x402");
    expect(verifyHermesPaymentTransaction(settledTransaction(), req, payerAddress).verified).toBe(true);
  });

  it("rejects a payment amount different from the challenge", async () => {
    const { verifyHermesPaymentTransaction } = await import("../src/x402");
    const tx = settledTransaction() as any;
    tx.transaction.message.instructions[0].parsed.info.tokenAmount.amount = "3008";
    expect(verifyHermesPaymentTransaction(tx, req, payerAddress).verified).toBe(false);
  });

  it("rejects a different recipient or facilitator", async () => {
    const { verifyHermesPaymentTransaction } = await import("../src/x402");
    const tx = settledTransaction() as any;
    tx.transaction.message.accountKeys[0].pubkey = "OtherFeePayer111111111111111111111111111";
    expect(verifyHermesPaymentTransaction(tx, req, payerAddress).verified).toBe(false);
  });

  it("rejects a payer that did not sign", async () => {
    const { verifyHermesPaymentTransaction } = await import("../src/x402");
    const tx = settledTransaction() as any;
    tx.transaction.message.accountKeys[1].signer = false;
    expect(verifyHermesPaymentTransaction(tx, req, payerAddress).verified).toBe(false);
  });
});
