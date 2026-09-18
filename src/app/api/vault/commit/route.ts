import { z } from "zod";
import { UUID_RE } from "@/crypto/bytes";
import { ApiError, api, json, parseJson } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { readStageToken } from "@/server/session";
import { batchingStore, slotOf } from "@/server/staging";
import { INDEX_PATH } from "@/vault/index-model";
import { type StagedItem, commitStagedItems } from "@/vault/remote";

const id = z.string().regex(UUID_RE);
const token = z.string().max(200);
const Body = z.object({
  items: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("part"), id, part: z.number().int().min(0).max(63), token }),
    z.object({ kind: z.literal("label"), id, token }),
    z.object({ kind: z.literal("index"), token }),
  ])).min(2).max(600),
});

/**
 * One atomic write for a whole upload: the documents' parts, their labels and
 * the index land together or not at all. New files are create-only, so nothing
 * already in the vault can be overwritten this way, and the index moves by
 * compare-and-swap exactly as it does on its own route (§9.2).
 */
export const POST = api({ auth: "session", limit: LIMITS.indexPut, write: true, maxBody: 256 * 1024 }, async ({ body, ifMatch }) => {
  const provider = await batchingStore();
  if (!provider) throw new ApiError(501, "not-supported");
  const { items } = parseJson(body, Body);
  if (items.filter((i) => i.kind === "index").length !== 1) throw new ApiError(400, "bad-request");

  // each token is only good for the slot its bytes were checked for
  const verified: StagedItem[] = items.map((item) => {
    const sha = readStageToken(slotOf(item), item.token);
    if (!sha) throw new ApiError(400, "bad-request");
    return { ...item, token: sha };
  });
  const versions = await commitStagedItems(provider, verified, ifMatch);
  return json({ indexVersion: versions.get(INDEX_PATH) });
});
