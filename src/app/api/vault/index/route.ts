import { ApiError, api, binary, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { store } from "@/server/store";
import { INDEX_PATH } from "@/vault/index-model";

const MAX_INDEX = 4 * 1024 * 1024;

export const GET = api({ auth: "session", limit: LIMITS.indexGet }, async () => {
  const { data, version } = await (await store()).get(INDEX_PATH);
  return binary(data, version);
});

/**
 * Compare-and-swap, always (§9.2). `If-Match: <version>` to replace, or
 * `If-None-Match: *` to create. There is no unconditional write.
 */
export const PUT = api({ auth: "session", limit: LIMITS.indexPut, write: true, maxBody: MAX_INDEX }, async ({ req, body, ifMatch }) => {
  if (body.length < 64 || body[0] !== 0x46 || body[1] !== 0x56 || body[2] !== 0x49 || body[3] !== 0x58) {
    throw new ApiError(400, "bad-request"); // "FVIX"
  }
  const create = req.headers.get("if-none-match") === "*";
  if (!ifMatch && !create) throw new ApiError(428, "precondition-required");
  const { version } = await (await store()).put(INDEX_PATH, body, ifMatch ? { ifMatch } : { ifNoneMatch: "*" });
  return json({ version });
});
