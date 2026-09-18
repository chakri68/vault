import { api, json } from "@/server/api";
import { env } from "@/server/env";
import { LIMITS } from "@/server/rate-limit";
import { loadRegistry } from "@/server/registry";
import { storeDescription } from "@/server/store";
import { readVaultJson } from "@/server/vault-files";
import { relyingParty } from "@/server/webauthn";

// A write here is several GitHub API calls in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

/**
 * The one public route (§6.2). It hands out what a locked client needs to
 * *attempt* an unlock — KDF parameters and salts, which aren't secret — and
 * deliberately not the wrapped keys. Those sit behind a session, so finding the
 * URL gets you a rate-limited login form, not offline guessing material.
 */
export const GET = api({ auth: "public", limit: LIMITS.config }, async ({ req }) => {
  const e = env();
  const base = {
    rpId: relyingParty(req).rpID,
    maxObjectBytes: e.maxObjectBytes,
    setupTokenRequired: !!e.setupToken,
    commit: e.commit ?? null,
  };
  try {
    const vault = await readVaultJson();
    if (!vault) return json({ ...base, initialized: false, storage: { ok: true, ...storeDescription() } });
    const registry = await loadRegistry();
    const password = vault.vault.envelopes.find((x) => x.kind === "password");
    const recovery = vault.vault.envelopes.find((x) => x.kind === "recovery-code");
    return json({
      ...base,
      initialized: true,
      // what kind of storage, and whether it keeps history. Not where: the location is only shown during setup.
      storage: { ok: true, provider: storeDescription().provider, versioning: storeDescription().versioning },
      formatVersion: vault.vault.formatVersion,
      vaultId: vault.vault.vaultId,
      kdf: password ? { params: password.kdf, salt: password.salt } : null,
      recoverySalt: recovery?.salt ?? null,
      prfSalt: vault.vault.prfSalt,
      hasPasskeys: (registry?.registry.credentials.length ?? 0) > 0,
    });
  } catch (err) {
    const detail = err instanceof Error && err.name === "StorageUnavailableError" ? err.message : "storage unavailable";
    return json({ ...base, initialized: null, storage: { ok: false, problem: detail, ...storeDescription() } });
  }
});
