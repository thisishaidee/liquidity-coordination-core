import { describe, expect, it } from "vitest";
import {
  decodeBase32, decryptTotpSecret, encodeBase32, encryptTotpSecret,
  generateTotpSecret, totpUri, verifyTotp, verifyTotpStep
} from "../src/telegram-totp";

describe("Telegram authenticator security", () => {
  it("round-trips base32 secrets", () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(decodeBase32(encodeBase32(source))).toEqual(source);
  });

  it("generates a Google Authenticator-compatible enrollment URI", () => {
    const uri = totpUri("JBSWY3DPEHPK3PXP", "operator@example.com");
    expect(uri).toContain("otpauth://totp/NERITH%3Aoperator");
    expect(uri).toContain("issuer=NERITH");
    expect(uri).toContain("digits=6&period=30");
  });

  it("encrypts secrets at rest and rejects a wrong encryption key", async () => {
    const encrypted = await encryptTotpSecret("JBSWY3DPEHPK3PXP", "a-secure-worker-key-with-at-least-32-chars");
    expect(await decryptTotpSecret(encrypted, "a-secure-worker-key-with-at-least-32-chars")).toBe("JBSWY3DPEHPK3PXP");
    await expect(decryptTotpSecret(encrypted, "a-different-worker-key-with-at-least-32-chars")).rejects.toThrow();
  });

  it("matches the RFC 6238 SHA-1 six-digit test vector", async () => {
    const secret = encodeBase32(new TextEncoder().encode("12345678901234567890"));
    expect(await verifyTotp(secret, "287082", 59_000)).toBe(true);
    expect(await verifyTotpStep(secret, "287082", 59_000)).toBe(1);
  });

  it("accepts only six-digit TOTP codes", async () => {
    expect(await verifyTotp("JBSWY3DPEHPK3PXP", "bad", 1_700_000_000_000)).toBe(false);
    expect(await verifyTotp("JBSWY3DPEHPK3PXP", "12345", 1_700_000_000_000)).toBe(false);
  });

  it("generates random enrollment secrets", async () => {
    const first = await generateTotpSecret();
    const second = await generateTotpSecret();
    expect(first).toMatch(/^[A-Z2-7]{32}$/);
    expect(second).not.toBe(first);
  });
});
