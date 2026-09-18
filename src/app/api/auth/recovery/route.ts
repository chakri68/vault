import { z } from "zod";
import { ApiError, api, json, parseJson } from "@/server/api";
import { LIMITS, recordAuthFailure, recordAuthSuccess } from "@/server/rate-limit";
import { loadRegistry, verifySecret } from "@/server/registry";
import { csrfToken, newSession, sessionCookie } from "@/server/session";

const Body = z.object({ authSecret: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) });

/**
 * The path of last resort: password forgotten, no enrolled device left. Whoever
 * holds the printed code holds the vault, so this session is an admin — they
 * need to set a new password and enrol a new phone.
 */
export const POST = api({ auth: "public", limit: LIMITS.authRecovery }, async ({ body, ip }) => {
  const { authSecret } = parseJson(body, Body);
  const loaded = await loadRegistry();
  const ok = !!loaded && verifySecret(Buffer.from(authSecret, "base64"), loaded.registry.recoveryAuth);
  if (!ok) {
    recordAuthFailure(LIMITS.authRecovery, `ip:${ip}`);
    throw new ApiError(401, "unauthenticated");
  }
  recordAuthSuccess(LIMITS.authRecovery, `ip:${ip}`);
  const session = newSession("admin", "recovery", loaded!.registry.sessionEpoch);
  return json({ role: session.role, csrf: csrfToken(session) }, { headers: { "set-cookie": sessionCookie(session) } });
});
