import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { VaultJsonSchema } from "@/schemas/vault";
import { ApiError, api, json, parseJson } from "@/server/api";
import { env } from "@/server/env";
import { LIMITS } from "@/server/rate-limit";
import { createRegistry, hashSecret, loadRegistry } from "@/server/registry";
import { csrfToken, newSession, sessionCookie } from "@/server/session";
import { readVaultJson, writeVaultJson } from "@/server/vault-files";

// A write here is several GitHub API calls in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

const secret = z.string().regex(/^[A-Za-z0-9+/]{43}=$/); // 32 bytes, base64

const Body = z.object({
  setupToken: z.string().max(200).optional(),
  /** "restore" brings an existing vault (from a backup) into an empty store */
  mode: z.enum(["create", "restore"]).default("create"),
  vaultJson: VaultJsonSchema,
  passwordAuthSecret: secret.optional(),
  recoveryAuthSecret: secret.optional(),
  writeAuthKey: secret,
});

/**
 * Creates the vault — or restores one. Only possible while the store is empty:
 * the store is the lock. The client generated (or unwrapped) the vault key
 * itself; all the server receives is envelopes it can't open and secrets it can
 * only verify.
 */
export const POST = api({ auth: "public", limit: LIMITS.setup, maxBody: 256 * 1024 }, async ({ body }) => {
  const input = parseJson(body, Body);

  const expected = env().setupToken;
  if (expected) {
    const a = Buffer.from(input.setupToken ?? "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(403, "setup-token");
  }
  if ((await readVaultJson(true)) || (await loadRegistry(true))) throw new ApiError(409, "already-initialized");

  let vaultJson = input.vaultJson;
  if (input.mode === "create") {
    const kinds = vaultJson.envelopes.map((x) => x.kind).sort().join(",");
    // §20.1: no vault without a recovery code
    if (kinds !== "password,recovery-code" || !input.passwordAuthSecret || !input.recoveryAuthSecret) {
      throw new ApiError(400, "bad-request");
    }
  } else {
    // Passkeys are bound to the origin they were made on and to a registry this
    // deployment doesn't have. They don't survive a restore; devices re-enrol.
    vaultJson = { ...vaultJson, envelopes: vaultJson.envelopes.filter((e) => e.kind !== "passkey-prf") };
    if (!input.passwordAuthSecret && !input.recoveryAuthSecret) throw new ApiError(400, "bad-request");
  }

  // Someone restoring with only the recovery code can't produce the password's
  // auth secret (and vice versa). That login stays shut — a random hash nobody
  // can match — until they set a new one, which the app asks for straight away.
  const shut = () => hashSecret(randomBytes(32));

  await writeVaultJson(vaultJson, undefined);
  await createRegistry({
    version: 1,
    vaultId: vaultJson.vaultId,
    passwordAuth: input.passwordAuthSecret ? hashSecret(Buffer.from(input.passwordAuthSecret, "base64")) : shut(),
    recoveryAuth: input.recoveryAuthSecret ? hashSecret(Buffer.from(input.recoveryAuthSecret, "base64")) : shut(),
    writeAuthKey: input.writeAuthKey,
    userHandle: randomBytes(16).toString("base64"),
    credentials: [],
    sessionEpoch: 1,
  });

  const session = newSession("admin", "setup", 1);
  return json({ role: session.role, csrf: csrfToken(session) }, { headers: { "set-cookie": sessionCookie(session) } });
});
