import { describe, expect, it } from "vitest";
import { fetchFinalizedSolanaTransaction } from "../src/solana-finalized-transaction";

const SIGNATURE = "5".repeat(87);
const ENDPOINT = "https://rpc.example.test";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("fetchFinalizedSolanaTransaction", () => {
  it("does not fetch transaction data before finalized commitment", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.method);
      return response({ result: { value: [{ confirmationStatus: "confirmed", err: null, slot: 10 }] } });
    };
    const result = await fetchFinalizedSolanaTransaction(ENDPOINT, SIGNATURE, fetcher);
    expect(result.state).toBe("pending");
    expect(calls).toEqual(["getSignatureStatuses"]);
  });

  it("does not classify a confirmed but unfinalized execution error as failed", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.method);
      return response({ result: { value: [{
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "Custom"] },
        slot: 11
      }] } });
    };
    const result = await fetchFinalizedSolanaTransaction(ENDPOINT, SIGNATURE, fetcher);
    expect(result.state).toBe("pending");
    expect(calls).toEqual(["getSignatureStatuses"]);
  });

  it("returns pending when the signature is not indexed", async () => {
    const fetcher: typeof fetch = async () => response({ result: { value: [null] } });
    const result = await fetchFinalizedSolanaTransaction(ENDPOINT, SIGNATURE, fetcher);
    expect(result.state).toBe("pending");
  });

  it("reports a finalized on-chain failure", async () => {
    const fetcher: typeof fetch = async () => response({
      result: { value: [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] }, slot: 12 }] }
    });
    const result = await fetchFinalizedSolanaTransaction(ENDPOINT, SIGNATURE, fetcher);
    expect(result.state).toBe("failed");
  });

  it("fetches parsed transaction only after finalized status and matches signature", async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      if (body.method === "getSignatureStatuses") {
        return response({ result: { value: [{ confirmationStatus: "finalized", err: null, slot: 123 }] } });
      }
      return response({ result: {
        slot: 123,
        transaction: { signatures: [SIGNATURE] },
        meta: { err: null }
      } });
    };
    const result = await fetchFinalizedSolanaTransaction(ENDPOINT, SIGNATURE, fetcher);
    expect(result.state).toBe("finalized");
    expect(calls.map(call => call.method)).toEqual(["getSignatureStatuses", "getTransaction"]);
    expect(calls[1].params[1]).toEqual({
      commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0
    });
  });

  it("does not treat a mismatched transaction response as finalized", async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      return body.method === "getSignatureStatuses"
        ? response({ result: { value: [{ confirmationStatus: "finalized", err: null, slot: 123 }] } })
        : response({ result: { slot: 123, transaction: { signatures: ["4".repeat(87)] }, meta: { err: null } } });
    };
    const result = await fetchFinalizedSolanaTransaction(ENDPOINT, SIGNATURE, fetcher);
    expect(result.state).toBe("pending");
  });

  it("rejects non-HTTPS RPC endpoints and malformed signatures", async () => {
    await expect(fetchFinalizedSolanaTransaction("http://rpc.example.test", SIGNATURE)).rejects.toThrow("HTTPS");
    await expect(fetchFinalizedSolanaTransaction(ENDPOINT, "not-a-signature")).rejects.toThrow("encoding");
  });
});
