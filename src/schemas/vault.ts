import { z } from "zod";

const b64 = z.string().min(1).max(4096);

export const KdfParamsSchema = z.object({
  name: z.literal("argon2id"),
  memory: z.number().int(),
  iterations: z.number().int(),
  parallelism: z.number().int(),
});

export const SealedFieldSchema = z.object({ nonce: b64, ciphertext: b64 });

/** §5.2. One per way into the vault. */
export const UnlockEnvelopeSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(["password", "passkey-prf", "recovery-code"]),
  /** "Mom's iPhone" is sensitive, so it's sealed under the VMK, never plain. */
  label: SealedFieldSchema.optional(),
  credentialId: z.string().max(2048).optional(),
  kdf: KdfParamsSchema.optional(),
  salt: b64,
  wrappedVmkNonce: b64,
  wrappedVmk: b64,
  createdAt: z.string(),
});
export type UnlockEnvelope = z.infer<typeof UnlockEnvelopeSchema>;

/** Non-sensitive by construction: no names, titles, tags or anything derived from them. */
export const VaultJsonSchema = z.object({
  format: z.literal("family-vault"),
  formatVersion: z.literal(1),
  vaultId: z.string().min(1).max(64),
  cipher: z.literal("AES-256-GCM"),
  /** public salt fed to the WebAuthn PRF extension; one per vault */
  prfSalt: b64,
  createdAt: z.string(),
  envelopes: z.array(UnlockEnvelopeSchema).min(1).max(64),
});
export type VaultJson = z.infer<typeof VaultJsonSchema>;
