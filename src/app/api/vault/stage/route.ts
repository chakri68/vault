import { PART_SIZE } from "@/crypto/container";
import { ApiError, api, json } from "@/server/api";
import { env } from "@/server/env";
import { objectTarget } from "@/server/object-target";
import { LIMITS } from "@/server/rate-limit";
import { stageToken } from "@/server/session";
import { batchingStore, slotOf } from "@/server/staging";
import type { StageItem } from "@/vault/remote";

const starts = (body: Uint8Array, magic: string) => [...magic].every((ch, i) => body[i] === ch.charCodeAt(0));

/**
 * Uploads opaque bytes without making them part of the vault: nothing references
 * them until /api/vault/commit names them. Same checks as writing the file
 * directly — size, and that it starts like what it claims to be — because those
 * are the only checks a server that can't read the bytes is able to make.
 */
export const PUT = api({ auth: "session", limit: LIMITS.objectPut, write: true, maxBody: PART_SIZE }, async ({ req, body }) => {
  const provider = await batchingStore();
  if (!provider) throw new ApiError(501, "not-supported");
  if (body.length === 0) throw new ApiError(400, "bad-request");

  const kind = new URL(req.url).searchParams.get("kind");
  let item: StageItem;
  if (kind === "index") {
    if (!starts(body, "FVIX") || body.length < 64) throw new ApiError(400, "bad-request");
    item = { kind };
  } else if (kind === "label") {
    if (!starts(body, "FVMD") || body.length < 110 || body.length > 256 * 1024) throw new ApiError(400, "bad-request");
    item = { kind, id: objectTarget(req).id };
  } else if (kind === "part") {
    const { id, part } = objectTarget(req);
    const maxParts = Math.ceil((env().maxObjectBytes + 2 * 1024 * 1024) / PART_SIZE);
    if (part >= maxParts) throw new ApiError(413, "too-large");
    if (part === 0 && !starts(body, "FVLT")) throw new ApiError(400, "bad-request");
    item = { kind, id, part };
  } else throw new ApiError(400, "bad-request");

  return json({ token: stageToken(slotOf(item), await provider.stageBlob(body)) });
});
