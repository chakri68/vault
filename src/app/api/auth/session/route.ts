import { api, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { csrfToken } from "@/server/session";

export const GET = api({ auth: "session", limit: LIMITS.meta }, async ({ session }) =>
  json({ role: session!.role, via: session!.via, csrf: csrfToken(session!), expiresAt: session!.exp }));
