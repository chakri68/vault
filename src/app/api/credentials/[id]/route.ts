import { z } from "zod";
import { ApiError, api, json, parseJson } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { updateRegistry } from "@/server/registry";
import { readVaultJson, writeVaultJson } from "@/server/vault-files";

// A write here is several GitHub API calls in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

type Params = { id: string };

/**
 * Removes a device: its login, and the envelope that let it unwrap the vault
 * key. What this can't do is un-copy anything that device already opened (§21.3).
 */
export const DELETE = api<Params>({ auth: "admin", limit: LIMITS.credentials, write: true }, async ({ params }) => {
  const id = decodeURIComponent(params.id);
  if (id.length > 1024) throw new ApiError(400, "bad-request");
  await updateRegistry((r) => { r.credentials = r.credentials.filter((c) => c.id !== id); });
  for (let attempt = 0; ; attempt++) {
    const current = await readVaultJson(true);
    if (!current) break;
    const envelopes = current.vault.envelopes.filter((e) => e.credentialId !== id);
    if (envelopes.length === current.vault.envelopes.length) break;
    try {
      await writeVaultJson({ ...current.vault, envelopes }, current.version);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
  return json({ ok: true });
});

const RoleBody = z.object({ role: z.enum(["admin", "member"]) });

export const PATCH = api<Params>({ auth: "admin", limit: LIMITS.credentials, write: true }, async ({ params, body }) => {
  const id = decodeURIComponent(params.id);
  const { role } = parseJson(body, RoleBody);
  await updateRegistry((r) => {
    const c = r.credentials.find((x) => x.id === id);
    if (!c) throw new ApiError(404, "not-found");
    // never demote the last admin into a vault nobody can manage
    if (role === "member" && c.role === "admin" && r.credentials.filter((x) => x.role === "admin").length === 1) {
      throw new ApiError(409, "last-admin");
    }
    c.role = role;
  });
  return json({ ok: true });
});
