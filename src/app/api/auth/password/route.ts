import { z } from "zod";
import { ApiError, api, json, parseJson } from "@/server/api";
import { LIMITS, recordAuthFailure, recordAuthSuccess } from "@/server/rate-limit";
import { loadRegistry, verifySecret } from "@/server/registry";
import { csrfToken, newSession, sessionCookie } from "@/server/session";

const Body = z.object({ authSecret: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) });

/**
 * Proves the caller knows the family password without the server ever holding
 * it, or anything that unwraps the vault key (§6.2).
 */
export const POST = api({ auth: "public", limit: LIMITS.authPassword }, async ({ body, ip }) => {
  const { authSecret } = parseJson(body, Body);
  const loaded = await loadRegistry();
  const ok = !!loaded && verifySecret(Buffer.from(authSecret, "base64"), loaded.registry.passwordAuth);
  if (!ok) {
    recordAuthFailure(LIMITS.authPassword, `ip:${ip}`);
    throw new ApiError(401, "unauthenticated"); // one answer for every kind of wrong (§40.6)
  }
  recordAuthSuccess(LIMITS.authPassword, `ip:${ip}`);

  // The family password is shared, so it can't say *who* this is. It gets member
  // rights; admin rights come from a passkey enrolled as admin. Until one
  // exists, the password has to be enough or nobody could manage the vault.
  const hasAdminPasskey = loaded!.registry.credentials.some((c) => c.role === "admin");
  const session = newSession(hasAdminPasskey ? "member" : "admin", "password", loaded!.registry.sessionEpoch);
  return json({ role: session.role, csrf: csrfToken(session) }, { headers: { "set-cookie": sessionCookie(session) } });
});
