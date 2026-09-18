import { type Bytes, asBytes, bytes, utf8 } from "./bytes";

/**
 * Domain separation labels. One secret in, several unrelated keys out: the
 * server sees the auth secret and still can't derive the wrapping key (§6.2).
 */
export const INFO = {
  passwordAuth: "fv-server-auth-v1",
  passwordWrap: "fv-key-wrap-v1",
  recoveryAuth: "fv-recovery-auth-v1",
  recoveryWrap: "fv-recovery-wrap-v1",
  prfWrap: "fv-prf-wrap-v1",
  writeAuth: "fv-write-auth-v1",
  fingerprint: "fv-vmk-fingerprint-v1",
} as const;

export type InfoLabel = (typeof INFO)[keyof typeof INFO];

export async function hkdf(
  secret: Bytes,
  info: InfoLabel,
  salt: Bytes = bytes(32),
  length = 32,
): Promise<Bytes> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8(info) },
    base,
    length * 8,
  );
  return asBytes(bits);
}

export async function hmacSha256(key: Bytes, message: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return asBytes(await crypto.subtle.sign("HMAC", k, message));
}
