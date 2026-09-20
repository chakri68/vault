import { z } from "zod";
import { VaultJsonSchema } from "@/schemas/vault";
import { ApiError, api, json, parseJson } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { hashSecret, updateRegistry } from "@/server/registry";
import { readVaultJson, writeVaultJson } from "@/server/vault-files";

// A write here is a store round trip — on GitHub, six of them in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

const Body = z.object({
  kind: z.enum(["password", "recovery-code"]),
  vaultJson: VaultJsonSchema,
  authSecret: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});

/**
 * A new family password, or a new recovery code. The client re-wrapped the
 * vault key under it; the server swaps that one envelope and the hash it
 * verifies logins against.
 *
 * Envelope first. If the second write fails, the old secret still signs in and
 * the new one still unlocks — awkward, recoverable. The other order can leave a
 * secret that signs in to a vault it can't open.
 */
export const POST = api({ auth: "admin", limit: LIMITS.credentials, write: true, maxBody: 256 * 1024 }, async ({ body, ifMatch }) => {
  const input = parseJson(body, Body);
  const current = await readVaultJson(true);
  if (!current) throw new ApiError(404, "not-found");
  if (input.vaultJson.vaultId !== current.vault.vaultId) throw new ApiError(400, "bad-request");

  // exactly one envelope of that kind, and nothing else may differ
  const others = (v: typeof current.vault) => JSON.stringify(v.envelopes.filter((e) => e.kind !== input.kind));
  if (others(input.vaultJson) !== others(current.vault)) throw new ApiError(400, "bad-request");
  if (input.vaultJson.envelopes.filter((e) => e.kind === input.kind).length !== 1) throw new ApiError(400, "bad-request");
  if (JSON.stringify({ ...input.vaultJson, envelopes: [] }) !== JSON.stringify({ ...current.vault, envelopes: [] })) {
    throw new ApiError(400, "bad-request");
  }

  await writeVaultJson(input.vaultJson, ifMatch ?? current.version);
  const hashed = hashSecret(Buffer.from(input.authSecret, "base64"));
  await updateRegistry((r) => {
    if (input.kind === "password") r.passwordAuth = hashed;
    else r.recoveryAuth = hashed;
  });
  return json({ ok: true });
});
