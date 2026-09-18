import { argon2id } from "hash-wasm";
import { type Bytes, asBytes, utf8 } from "./bytes";

export interface KdfParams {
  name: "argon2id";
  memory: number; // KiB
  iterations: number;
  parallelism: number;
}

/**
 * Fixed, not tuned per device. Tuning on whatever runs setup (probably a
 * laptop) hands a parent's phone parameters it can't afford, and a high memory
 * setting can fail outright in an iOS PWA. 64 MiB / t=3 is the OWASP-ish floor
 * that a low-end Android still clears in about a second.
 */
export const DEFAULT_KDF: KdfParams = {
  name: "argon2id",
  memory: 64 * 1024,
  iterations: 3,
  parallelism: 1,
};

// Refuse parameters from an untrusted vault.json that would weaken the KDF to
// nothing or wedge the device.
const MIN_MEMORY = 19 * 1024;
const MAX_MEMORY = 1024 * 1024;

export function assertSaneKdf(p: KdfParams): void {
  const ok =
    p.name === "argon2id" &&
    Number.isInteger(p.memory) && p.memory >= MIN_MEMORY && p.memory <= MAX_MEMORY &&
    Number.isInteger(p.iterations) && p.iterations >= 2 && p.iterations <= 32 &&
    Number.isInteger(p.parallelism) && p.parallelism >= 1 && p.parallelism <= 8;
  if (!ok) throw new Error("unsupported key derivation parameters");
}

/** NFKC so the same passphrase typed on two keyboards yields the same bytes. */
export function normalizePassword(password: string): Bytes {
  return utf8(password.normalize("NFKC"));
}

export async function deriveFromPassword(
  password: string,
  salt: Bytes,
  params: KdfParams = DEFAULT_KDF,
): Promise<Bytes> {
  assertSaneKdf(params);
  const out = await argon2id({
    password: normalizePassword(password),
    salt,
    memorySize: params.memory,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: "binary",
  });
  return asBytes(out);
}
