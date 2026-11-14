import { describe, expect, it } from "vitest";
import {
  decodeSolanaAddress,
  decodeSolanaSignature,
  verifySolanaMessageSignature
} from "../src/solana-wallet-verification";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const digit = Number(value % 58n);
    encoded = ALPHABET[digit] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes++;
  return "1".repeat(leadingZeroes) + encoded;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

describe("Solana wallet message verification", () => {
  it("decodes a base58 Solana public key to exactly 32 bytes", () => {
    expect(decodeSolanaAddress("11111111111111111111111111111111")).toEqual(new Uint8Array(32));
    expect(() => decodeSolanaAddress("0OIl")).toThrow("invalid_solana_address");
    expect(() => decodeSolanaAddress("111")).toThrow("invalid_solana_address");
  });

  it("rejects malformed signatures before cryptographic verification", () => {
    expect(() => decodeSolanaSignature("not-a-signature")).toThrow("invalid_signature_encoding");
    expect(() => decodeSolanaSignature("AQ")).toThrow("invalid_signature_length");
  });

  it("verifies a valid Ed25519 message signature against the registered address", async () => {
    const generateEd25519KeyPair = crypto.subtle.generateKey as unknown as (algorithm: { name: string }, extractable: boolean, usages: string[]) => Promise<CryptoKeyPair>;
    const keyPair = await generateEd25519KeyPair({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const address = encodeBase58(publicKey);
    const message = "NERITH wallet ownership challenge";
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(message)));
    const encodedSignature = encodeBase64Url(signature);

    expect(await verifySolanaMessageSignature(address, message, encodedSignature)).toBe(true);
    expect(await verifySolanaMessageSignature(address, message + " altered", encodedSignature)).toBe(false);
    expect(await verifySolanaMessageSignature("11111111111111111111111111111111", message, encodedSignature)).toBe(false);
  });
});
