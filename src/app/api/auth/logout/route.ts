import { api, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { clearSessionCookie } from "@/server/session";

// A write here is a store round trip — on GitHub, six of them in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

export const POST = api({ auth: "session", limit: LIMITS.meta, csrf: true }, async () =>
  json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } }));
