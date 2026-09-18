import type { UnlockEnvelope, VaultJson } from "@/schemas/vault";
import { KEY_LENGTH, importAesKey, open, seal } from "./aes";
import { type Bytes, fromBase64, fromUtf8, newId, randomBytes, toBase64, utf8 } from "./bytes";
import { INFO, type InfoLabel, hkdf } from "./hkdf";
import { DEFAULT_KDF, type KdfParams, deriveFromPassword } from "./kdf";
import { recoveryCodeSecret } from "./recovery-code";

const SALT_LENGTH = 32;

/** Binds a wrapped VMK to its vault, envelope and kind, so envelopes can't be shuffled. */
function wrapContext(vaultId: string, envelopeId: string, kind: UnlockEnvelope["kind"]): string {
  return `fv:vmk:${vaultId}:${envelopeId}:${kind}`;
}

const labelContext = (envelopeId: string) => `fv:envelope-label:${envelopeId}`;

export function generateVmk(): Bytes {
  return randomBytes(KEY_LENGTH);
}

export interface PasswordKeys {
  /** sent to the server, which stores a salted hash of it */
  authSecret: Bytes;
  /** never leaves the device */
  wrappingKey: Bytes;
}

/**
 * One Argon2id run, two keys. The server can verify the caller knows the family
 * password and still has nothing that unwraps the VMK (§6.2).
 */
export async function derivePasswordKeys(
  password: string,
  salt: Bytes,
  params: KdfParams = DEFAULT_KDF,
): Promise<PasswordKeys> {
  const root = await deriveFromPassword(password, salt, params);
  try {
    const [authSecret, wrappingKey] = await Promise.all([
      hkdf(root, INFO.passwordAuth, salt),
      hkdf(root, INFO.passwordWrap, salt),
    ]);
    return { authSecret, wrappingKey };
  } finally {
    root.fill(0);
  }
}

/** The recovery code is already full-entropy, so HKDF alone and no password KDF (§5.1 path C). */
export async function deriveRecoveryKeys(code: string, salt: Bytes): Promise<PasswordKeys> {
  const secret = recoveryCodeSecret(code);
  const [authSecret, wrappingKey] = await Promise.all([
    hkdf(secret, INFO.recoveryAuth, salt),
    hkdf(secret, INFO.recoveryWrap, salt),
  ]);
  return { authSecret, wrappingKey };
}

export function derivePrfWrappingKey(prfOutput: Bytes, salt: Bytes): Promise<Bytes> {
  return hkdf(prfOutput, INFO.prfWrap, salt);
}

async function wrapVmk(
  vmk: Bytes,
  wrappingKey: Bytes,
  vaultId: string,
  base: Pick<UnlockEnvelope, "id" | "kind" | "credentialId" | "kdf"> & { salt: Bytes },
): Promise<UnlockEnvelope> {
  const key = await importAesKey(wrappingKey);
  const sealed = await seal(key, vmk, wrapContext(vaultId, base.id, base.kind));
  return {
    id: base.id,
    kind: base.kind,
    credentialId: base.credentialId,
    kdf: base.kdf,
    salt: toBase64(base.salt),
    wrappedVmkNonce: toBase64(sealed.nonce),
    wrappedVmk: toBase64(sealed.ciphertext),
    createdAt: new Date().toISOString(),
  };
}

/** Throws DecryptError when the wrapping key is wrong. Same error for every cause. */
export async function unwrapVmk(
  envelope: UnlockEnvelope,
  wrappingKey: Bytes,
  vaultId: string,
): Promise<Bytes> {
  const key = await importAesKey(wrappingKey);
  return open(
    key,
    fromBase64(envelope.wrappedVmkNonce),
    fromBase64(envelope.wrappedVmk),
    wrapContext(vaultId, envelope.id, envelope.kind),
  );
}

export async function createPasswordEnvelope(vmk: Bytes, vaultId: string, password: string) {
  const salt = randomBytes(SALT_LENGTH);
  const keys = await derivePasswordKeys(password, salt, DEFAULT_KDF);
  const envelope = await wrapVmk(vmk, keys.wrappingKey, vaultId, {
    id: newId(), kind: "password", kdf: DEFAULT_KDF, salt,
  });
  keys.wrappingKey.fill(0);
  return { envelope, authSecret: keys.authSecret };
}

export async function createRecoveryEnvelope(vmk: Bytes, vaultId: string, code: string) {
  const salt = randomBytes(SALT_LENGTH);
  const keys = await deriveRecoveryKeys(code, salt);
  const envelope = await wrapVmk(vmk, keys.wrappingKey, vaultId, {
    id: newId(), kind: "recovery-code", salt,
  });
  keys.wrappingKey.fill(0);
  return { envelope, authSecret: keys.authSecret };
}

export async function createPrfEnvelope(
  vmk: Bytes,
  vaultId: string,
  credentialId: string,
  prfOutput: Bytes,
): Promise<UnlockEnvelope> {
  const salt = randomBytes(SALT_LENGTH);
  const wrappingKey = await derivePrfWrappingKey(prfOutput, salt);
  try {
    return await wrapVmk(vmk, wrappingKey, vaultId, { id: newId(), kind: "passkey-prf", credentialId, salt });
  } finally {
    wrappingKey.fill(0);
  }
}

export async function sealLabel(vmk: CryptoKey, envelopeId: string, label: string) {
  const sealed = await seal(vmk, utf8(label), labelContext(envelopeId));
  return { nonce: toBase64(sealed.nonce), ciphertext: toBase64(sealed.ciphertext) };
}

export async function openLabel(vmk: CryptoKey, envelope: UnlockEnvelope): Promise<string | undefined> {
  if (!envelope.label) return undefined;
  const plain = await open(
    vmk, fromBase64(envelope.label.nonce), fromBase64(envelope.label.ciphertext), labelContext(envelope.id),
  );
  return fromUtf8(plain);
}

/**
 * K_w: the server holds this and checks an HMAC on every mutating request, so a
 * stolen session alone can't destroy anything — the caller must also have
 * unwrapped the VMK. HKDF is one-way, so K_w says nothing about the VMK.
 */
export function deriveWriteAuthKey(vmk: Bytes, vaultId: string): Promise<Bytes> {
  return hkdf(vmk, INFO.writeAuth, utf8(vaultId));
}

/** Remembered per device; a changed fingerprint means vault.json was swapped under us. */
export async function vmkFingerprint(vmk: Bytes, vaultId: string): Promise<string> {
  return toBase64(await hkdf(vmk, INFO.fingerprint as InfoLabel, utf8(vaultId), 16));
}

export function newVaultJson(envelopes: UnlockEnvelope[], vaultId = newId()): VaultJson {
  return {
    format: "family-vault",
    formatVersion: 1,
    vaultId,
    cipher: "AES-256-GCM",
    prfSalt: toBase64(randomBytes(32)),
    createdAt: new Date().toISOString(),
    envelopes,
  };
}
