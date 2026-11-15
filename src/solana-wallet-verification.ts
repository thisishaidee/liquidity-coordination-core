const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function decodeSolanaAddress(address: string): Uint8Array {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) {
    throw new Error("invalid_solana_address");
  }
  let value = 0n;
  for (const character of address) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error("invalid_solana_address");
    value = value * 58n + BigInt(digit);
  }
  const decoded: number[] = [];
  while (value > 0n) {
    decoded.unshift(Number(value & 255n));
    value >>= 8n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < address.length && address[leadingZeroes] === "1") leadingZeroes++;
  const result = new Uint8Array(leadingZeroes + decoded.length);
  result.set(decoded, leadingZeroes);
  if (result.length !== 32) throw new Error("invalid_solana_address");
  return result;
}

export function decodeSolanaSignature(signature: string): Uint8Array {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(signature)) {
    throw new Error("invalid_signature_encoding");
  }
  const normalized = signature.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length !== 64) throw new Error("invalid_signature_length");
  return bytes;
}

export async function verifySolanaMessageSignature(
  address: string,
  message: string,
  signature: string
): Promise<boolean> {
  if (typeof message !== "string" || message.length < 1 || message.length > 4096) return false;
  try {
    const publicKeyBytes = decodeSolanaAddress(address);
    const signatureBytes = decodeSolanaSignature(signature);
    const publicKey = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      signatureBytes,
      new TextEncoder().encode(message)
    );
  } catch {
    return false;
  }
}
