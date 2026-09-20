import { PART_SIZE } from "@/crypto/container";
import { ApiError, api, binary, json } from "@/server/api";
import { env } from "@/server/env";
import { objectTarget } from "@/server/object-target";
import { LIMITS } from "@/server/rate-limit";
import { store } from "@/server/store";
import { isPreconditionFailed } from "@/storage/provider";
import { objectPath } from "@/vault/index-model";

// A write here is a store round trip — on GitHub, six of them in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

const MAGIC = [0x46, 0x56, 0x4c, 0x54]; // "FVLT"

export const GET = api({ auth: "session", limit: LIMITS.objectGet }, async ({ req }) => {
  const { id, part } = objectTarget(req);
  const { data, version } = await (await store()).get(objectPath(id, part));
  return binary(data, version);
});

/**
 * Opaque bytes in. The server checks the size and that part 0 starts like a
 * container; it can't check more, because it can't read more. Anything
 * JSON-shaped — a filename, a person — has no way to arrive here (§32).
 */
export const PUT = api({ auth: "session", limit: LIMITS.objectPut, write: true, maxBody: PART_SIZE }, async ({ req, body }) => {
  const { id, part } = objectTarget(req);
  if (body.length === 0) throw new ApiError(400, "bad-request");
  // the real ceiling is enforced here; the client's is a hint (§13)
  const maxParts = Math.ceil((env().maxObjectBytes + 2 * 1024 * 1024) / PART_SIZE);
  if (part >= maxParts) throw new ApiError(413, "too-large");
  if (part === 0 && MAGIC.some((b, i) => body[i] !== b)) throw new ApiError(400, "bad-request");

  try {
    await (await store()).put(objectPath(id, part), body, { ifNoneMatch: "*" });
  } catch (e) {
    // Content is immutable. A retry of a part that already landed is fine; anything else isn't ours to overwrite.
    if (!isPreconditionFailed(e)) throw e;
  }
  return json({ ok: true });
});
