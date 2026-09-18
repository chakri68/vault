import { api, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { updateRegistry } from "@/server/registry";
import { clearSessionCookie } from "@/server/session";

/** Signs every device out, this one included: sessions carry the epoch they were issued under. */
export const POST = api({ auth: "admin", limit: LIMITS.credentials, write: true }, async () => {
  await updateRegistry((r) => { r.sessionEpoch += 1; });
  return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
});
