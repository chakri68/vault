import { ApiError, api, binary, json } from "@/server/api";
import { objectTarget } from "@/server/object-target";
import { LIMITS } from "@/server/rate-limit";
import { store } from "@/server/store";
import { sidecarPath } from "@/vault/index-model";

export const GET = api({ auth: "session", limit: LIMITS.objectGet }, async ({ req }) => {
  const { data, version } = await (await store()).get(sidecarPath(objectTarget(req).id));
  return binary(data, version);
});

/** The editable label on a document. Compare-and-swap, like the index. */
export const PUT = api({ auth: "session", limit: LIMITS.objectPut, write: true, maxBody: 256 * 1024 }, async ({ req, body, ifMatch }) => {
  const { id } = objectTarget(req);
  if (body.length < 110 || body[0] !== 0x46 || body[1] !== 0x56 || body[2] !== 0x4d || body[3] !== 0x44) {
    throw new ApiError(400, "bad-request"); // "FVMD"
  }
  const create = req.headers.get("if-none-match") === "*";
  if (!ifMatch && !create) throw new ApiError(428, "precondition-required");
  const { version } = await (await store()).put(sidecarPath(id), body, ifMatch ? { ifMatch } : { ifNoneMatch: "*" });
  return json({ version });
});
