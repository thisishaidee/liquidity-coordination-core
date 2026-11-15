import { describe, expect, it } from "vitest";
import { fetchFinalizedSplTokenBalance } from "../src/solana-finalized-balance";

const owner = "Owner1111111111111111111111111111111111";
const mint = "Mint111111111111111111111111111111111111";

function response(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 503, headers: { "content-type": "application/json" } });
}

describe("finalized SPL token balance lookup", () => {
  it("requests finalized commitment and aggregates every matching token account", async () => {
    let requestBody: any;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return response({ result: { value: [
        { account: { data: { parsed: { info: { owner, mint, tokenAmount: { amount: "1200000", decimals: 6 } } } } } },
        { account: { data: { parsed: { info: { owner, mint, tokenAmount: { amount: "3400000", decimals: 6 } } } } } }
      ] } });
    };
    await expect(fetchFinalizedSplTokenBalance("https://rpc.example", owner, mint, 6, fetcher))
      .resolves.toEqual({ amountAtoms: "4600000", commitment: "finalized" });
    expect(requestBody.method).toBe("getTokenAccountsByOwner");
    expect(requestBody.params[2].commitment).toBe("finalized");
  });

  it("returns zero when no token accounts exist", async () => {
    await expect(fetchFinalizedSplTokenBalance("https://rpc.example", owner, mint, 6,
      async () => response({ result: { value: [] } })))
      .resolves.toEqual({ amountAtoms: "0", commitment: "finalized" });
  });

  it.each([
    { owner: "OtherOwner", mint, tokenAmount: { amount: "1", decimals: 6 } },
    { owner, mint: "OtherMint", tokenAmount: { amount: "1", decimals: 6 } },
    { owner, mint, tokenAmount: { amount: "1", decimals: 9 } },
    { owner, mint, tokenAmount: { amount: "-1", decimals: 6 } },
    { owner, mint, tokenAmount: { amount: "01", decimals: 6 } }
  ])("rejects a token account that does not match the requested identity", async info => {
    await expect(fetchFinalizedSplTokenBalance("https://rpc.example", owner, mint, 6,
      async () => response({ result: { value: [{ account: { data: { parsed: { info } } } }] } })))
      .rejects.toThrow();
  });

  it("rejects non-HTTPS RPC endpoints and malformed responses", async () => {
    await expect(fetchFinalizedSplTokenBalance("http://rpc.example", owner, mint, 6)).rejects.toThrow(/HTTPS/);
    await expect(fetchFinalizedSplTokenBalance("https://rpc.example", owner, mint, 6,
      async () => response({ result: {} }))).rejects.toThrow(/malformed/);
  });

  it("rejects RPC failures", async () => {
    await expect(fetchFinalizedSplTokenBalance("https://rpc.example", owner, mint, 6,
      async () => response({}, false))).rejects.toThrow(/HTTP 503/);
  });
});
