import { type Bytes, randomBytes, utf8 } from "./bytes";
import { sha256 } from "./checksum";

/**
 * Recovery code: 8 groups of 4 Crockford base32 characters.
 *
 *   31 random symbols (155 bits, used via HKDF) + 1 check symbol
 *
 * Crockford drops I, L, O and U, so the code survives being handwritten and
 * read back by someone else. The check symbol catches a typo before we spend
 * an unwrap attempt (and a rate-limit slot) on it.
 */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const GROUPS = 8;
export const GROUP_SIZE = 4;
const LENGTH = GROUPS * GROUP_SIZE;

async function checkSymbol(body: string): Promise<string> {
  const digest = await sha256(utf8(body));
  return ALPHABET[digest[0] >> 3];
}

export async function generateRecoveryCode(): Promise<string> {
  // 256 % 32 === 0, so masking a random byte to 5 bits is unbiased
  const random = randomBytes(LENGTH - 1);
  let body = "";
  for (const b of random) body += ALPHABET[b & 31];
  return body + (await checkSymbol(body));
}

/** "K7QM4X2P…" → ["K7QM", "4X2P", …] */
export function groupsOf(code: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < code.length; i += GROUP_SIZE) out.push(code.slice(i, i + GROUP_SIZE));
  return out;
}

export function formatRecoveryCode(code: string): string {
  return groupsOf(code).join(" ");
}

/** Uppercases, drops separators, and applies Crockford's read-back aliases. */
export function normalizeRecoveryInput(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-_.·]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export type RecoveryCodeProblem = "length" | "characters" | "check";

/** Returns the canonical 32-character code, or what's wrong with the input. */
export async function parseRecoveryCode(
  input: string,
): Promise<{ ok: true; code: string } | { ok: false; problem: RecoveryCodeProblem }> {
  const code = normalizeRecoveryInput(input);
  if (code.length !== LENGTH) return { ok: false, problem: "length" };
  for (const ch of code) if (!ALPHABET.includes(ch)) return { ok: false, problem: "characters" };
  if ((await checkSymbol(code.slice(0, -1))) !== code.at(-1)) return { ok: false, problem: "check" };
  return { ok: true, code };
}

/** Key material for HKDF. The canonical string, so formatting never matters. */
export function recoveryCodeSecret(code: string): Bytes {
  return utf8(code);
}
