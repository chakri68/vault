import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { NotFoundError, PreconditionFailedError, isNotFound, isPreconditionFailed } from "@/storage/provider";
import { env } from "./env";
import { store } from "./store";

/**
 * server/registry.json — what the server needs to decide "may this caller touch
 * the store". It lives in the store because a serverless function remembers
 * nothing between requests, and losing this would lock everyone out of saving.
 *
 * None of it helps decrypt anything: public keys, salted hashes of auth secrets
 * that are themselves one-way derivations, and the write-auth key, which HKDF
 * separates from the VMK. It leaks no more than vault.json already does.
 */
const b64 = z.string().min(1).max(2048);

const SecretHashSchema = z.object({ salt: b64, hash: b64 });

const CredentialSchema = z.object({
  id: z.string().min(1).max(1024), // base64url credential id
  publicKey: b64,
  counter: z.number().int().nonnegative(),
  transports: z.array(z.string()).optional(),
  role: z.enum(["admin", "member"]),
  createdAt: z.string(),
});
export type RegisteredCredential = z.infer<typeof CredentialSchema>;

const RegistrySchema = z.object({
  version: z.literal(1),
  vaultId: z.string(),
  passwordAuth: SecretHashSchema,
  recoveryAuth: SecretHashSchema,
  writeAuthKey: b64,
  /** WebAuthn user handle: random, stable, means nothing */
  userHandle: b64,
  credentials: z.array(CredentialSchema),
  /** bump to sign every device out */
  sessionEpoch: z.number().int().nonnegative(),
});
export type Registry = z.infer<typeof RegistrySchema>;

export const REGISTRY_PATH = "server/registry.json";

export function hashSecret(secret: Buffer, salt = randomBytes(16)): z.infer<typeof SecretHashSchema> {
  // The secret is 256 bits of KDF output, not a password: a keyed hash is plenty.
  const hash = createHmac("sha256", salt).update(secret).digest();
  return { salt: salt.toString("base64"), hash: hash.toString("base64") };
}

export function verifySecret(secret: Buffer, stored: z.infer<typeof SecretHashSchema>): boolean {
  const expected = Buffer.from(stored.hash, "base64");
  const actual = createHmac("sha256", Buffer.from(stored.salt, "base64")).update(secret).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const g = globalThis as unknown as { __fvRegistry?: { value: Registry; version: string; at: number } | null };
/**
 * Read on nearly every request. Our own writes refresh the cache immediately, so
 * the TTL only bounds how long *another* server instance takes to notice a
 * removed device or a sign-out-everywhere. That makes it a revocation window,
 * and shorter is safer.
 *
 * A minute was the price of GitHub, where a read costs about a second. On any
 * store with quick reads — R2 answers in tens of milliseconds from the same
 * region — the window can be much smaller for one cheap read every few seconds
 * per warm instance. GitHub keeps the long TTL, because it is still the
 * documented rollback and a five-second one there would put a second onto
 * roughly every request.
 */
const ttlMs = () => (env().storage.provider === "github" ? 60_000 : 5_000);

export async function loadRegistry(fresh = false): Promise<{ registry: Registry; version: string } | null> {
  const cached = g.__fvRegistry;
  if (!fresh && cached && Date.now() - cached.at < ttlMs()) return { registry: cached.value, version: cached.version };
  try {
    const { data, version } = await (await store()).get(REGISTRY_PATH);
    const registry = RegistrySchema.parse(JSON.parse(Buffer.from(data).toString("utf8")));
    g.__fvRegistry = { value: registry, version, at: Date.now() };
    return { registry, version };
  } catch (e) {
    if (isNotFound(e)) {
      g.__fvRegistry = null;
      return null;
    }
    throw e;
  }
}

export async function createRegistry(registry: Registry): Promise<void> {
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(registry, null, 2), "utf8")) as Uint8Array<ArrayBuffer>;
  const { version } = await (await store()).put(REGISTRY_PATH, bytes, { ifNoneMatch: "*" });
  g.__fvRegistry = { value: registry, version, at: Date.now() };
}

/** Read-modify-write with compare-and-swap; retried, because two devices can enrol at once. */
export async function updateRegistry(mutate: (r: Registry) => Registry | void): Promise<Registry> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await loadRegistry(true);
    if (!current) throw new NotFoundError();
    const draft = structuredClone(current.registry);
    const next = RegistrySchema.parse(mutate(draft) ?? draft);
    const bytes = new Uint8Array(Buffer.from(JSON.stringify(next, null, 2), "utf8")) as Uint8Array<ArrayBuffer>;
    try {
      const { version } = await (await store()).put(REGISTRY_PATH, bytes, { ifMatch: current.version });
      g.__fvRegistry = { value: next, version, at: Date.now() };
      return next;
    } catch (e) {
      if (!isPreconditionFailed(e)) throw e;
    }
  }
  throw new PreconditionFailedError();
}
