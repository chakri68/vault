import { ApiError, api, binary } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { readVaultJson } from "@/server/vault-files";

/** vault.json: the wrapped keys. Behind a session, unlike the public config. */
export const GET = api({ auth: "session", limit: LIMITS.meta }, async () => {
  const vault = await readVaultJson();
  if (!vault) throw new ApiError(404, "not-found");
  return binary(vault.data, vault.version);
});
