import { ApiError, api, json } from "@/server/api";
import { objectTarget } from "@/server/object-target";
import { LIMITS } from "@/server/rate-limit";
import { store } from "@/server/store";
import { PreconditionFailedError } from "@/storage/provider";
import { INDEX_PATH } from "@/vault/index-model";
import { deleteObjectFiles, groupObjects } from "@/vault/remote";

// A write here is a store round trip — on GitHub, six of them in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

/**
 * Reconciliation only (§6.5): ids and sizes, for finding orphans and rebuilding
 * the index. The authoritative list is inside the encrypted index.
 */
export const GET = api({ auth: "session", limit: LIMITS.objectList }, async () =>
  json({ objects: groupObjects(await (await store()).list("objects/")) }));

/**
 * Admin only, and only with proof of the current index version (§6.4). Blind
 * destruction needs a real credential compromise, not a URL.
 */
export const DELETE = api({ auth: "admin", limit: LIMITS.objectDelete, write: true }, async ({ req, ifMatch }) => {
  const { id } = objectTarget(req);
  if (!ifMatch) throw new ApiError(428, "precondition-required");
  const provider = await store();
  const index = await provider.get(INDEX_PATH);
  if (index.version !== ifMatch) throw new PreconditionFailedError();
  await deleteObjectFiles(provider, id);
  return json({ ok: true });
});
