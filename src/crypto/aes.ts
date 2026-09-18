import { type Bytes, asBytes, randomBytes, utf8 } from "./bytes";

export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;
export const KEY_LENGTH = 32;

/** Thrown for any authentication failure. Deliberately carries no detail (§40.6). */
export class DecryptError extends Error {
  constructor() {
    super("decryption failed");
    this.name = "DecryptError";
  }
}

export function importAesKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== KEY_LENGTH) throw new Error("AES-256 key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface Sealed {
  nonce: Bytes;
  ciphertext: Bytes; // includes the 16-byte tag
}

/**
 * AES-256-GCM with a fresh random 96-bit nonce per call. `context` is bound in
 * as additional data so a ciphertext can't be replayed into a different slot
 * (another object's header, a different envelope, …).
 */
export async function seal(key: CryptoKey, plaintext: Bytes, context: string): Promise<Sealed> {
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: utf8(context), tagLength: TAG_LENGTH * 8 },
    key,
    plaintext,
  );
  return { nonce, ciphertext: asBytes(ciphertext) };
}

export async function open(
  key: CryptoKey,
  nonce: Bytes,
  ciphertext: Bytes,
  context: string,
): Promise<Bytes> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: utf8(context), tagLength: TAG_LENGTH * 8 },
      key,
      ciphertext,
    );
    return asBytes(plaintext);
  } catch {
    throw new DecryptError();
  }
}
