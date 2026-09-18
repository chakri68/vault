import { api, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { clearSessionCookie } from "@/server/session";

export const POST = api({ auth: "session", limit: LIMITS.meta, csrf: true }, async () =>
  json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } }));
