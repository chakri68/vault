import { ApiError, api, binary } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { readVaultJson } from "@/server/vault-files";

// A write here is a store round trip — on GitHub, six of them in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

/** vault.json: the wrapped keys. Behind a session, unlike the public config. */
export const GET = api({ auth: "session", limit: LIMITS.meta }, async () => {
  const vault = await readVaultJson();
  if (!vault) throw new ApiError(404, "not-found");
  return binary(vault.data, vault.version);
});
