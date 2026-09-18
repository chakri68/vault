import { api, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { csrfToken } from "@/server/session";

// A write here is several GitHub API calls in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

export const GET = api({ auth: "session", limit: LIMITS.meta }, async ({ session }) =>
  json({ role: session!.role, via: session!.via, csrf: csrfToken(session!), expiresAt: session!.exp }));
