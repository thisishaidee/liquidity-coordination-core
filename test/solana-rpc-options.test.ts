import { describe, expect, it } from "vitest";
import { FINALIZED_TRANSACTION_READ_OPTIONS } from "../src/solana-rpc-options";

describe("finalized Solana transaction read options", () => {
  it("accepts legacy, v0 and active v1 transaction formats", () => {
    expect(FINALIZED_TRANSACTION_READ_OPTIONS).toEqual({
      commitment: "finalized",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 1
    });
  });
});
