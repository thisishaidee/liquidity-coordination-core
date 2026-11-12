const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(input: string): Uint8Array {
  const normalized = input.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of normalized) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

export async function generateTotpSecret(): Promise<string> {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(20)));
}

export async function encryptTotpSecret(secret: string, encryptionKey: string): Promise<string> {
  if (encryptionKey.length < 32) throw new Error("TOTP encryption key must contain at least 32 characters");
  const rawKey = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptionKey));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  return [...iv, ...new Uint8Array(encrypted)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function decryptTotpSecret(encrypted: string, encryptionKey: string): Promise<string> {
  if (encryptionKey.length < 32) throw new Error("TOTP encryption key must contain at least 32 characters");
  if (!/^[a-f0-9]+$/i.test(encrypted) || encrypted.length < 58 || encrypted.length % 2 !== 0) {
    throw new Error("invalid encrypted TOTP secret");
  }
  const bytes = new Uint8Array(encrypted.match(/.{2}/g)!.map(pair => Number.parseInt(pair, 16)));
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const rawKey = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptionKey));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

async function totpAt(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", decodeBase32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const message = new Uint8Array(8);
  let value = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    message[i] = Number(value & 255n);
    value >>= 8n;
  }
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(binary % 1_000_000).padStart(6, "0");
}

export async function verifyTotp(secret: string, code: string, now = Date.now()): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(now / 30_000);
  for (const drift of [-1, 0, 1]) {
    if (await totpAt(secret, counter + drift) === code) return true;
  }
  return false;
}

export function totpUri(secret: string, account: string, issuer = "NERITH"): string {
  const label = encodeURIComponent(issuer + ":" + account);
  return "otpauth://totp/" + label + "?secret=" + secret + "&issuer=" +
    encodeURIComponent(issuer) + "&algorithm=SHA1&digits=6&period=30";
}
