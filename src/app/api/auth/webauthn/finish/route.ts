import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { ApiError, api, json, parseJson } from "@/server/api";
import { LIMITS, recordAuthFailure } from "@/server/rate-limit";
import { loadRegistry, updateRegistry } from "@/server/registry";
import { challengeCookieName, clearChallengeCookie, csrfToken, newSession, readChallenge, sessionCookie } from "@/server/session";
import { verifyAuthentication } from "@/server/webauthn";

const Body = z.object({ response: z.looseObject({ id: z.string().max(1024), type: z.literal("public-key") }) });

export const POST = api({ auth: "public", limit: LIMITS.authWebauthn, maxBody: 32 * 1024 }, async ({ req, body, ip }) => {
  const { response } = parseJson(body, Body);
  const challenge = readChallenge(req.cookies.get(challengeCookieName())?.value, "auth");
  const loaded = await loadRegistry();
  if (!challenge || !loaded) throw new ApiError(401, "unauthenticated");

  let verified;
  try {
    verified = await verifyAuthentication(req, loaded.registry, response as unknown as AuthenticationResponseJSON, challenge);
  } catch (e) {
    recordAuthFailure(LIMITS.authWebauthn, `ip:${ip}`);
    throw e;
  }
  // Synced passkeys report a counter of 0 forever. Only write when it actually
  // moved, or every unlock would be a commit to the store.
  if (verified.newCounter > verified.credential.counter) {
    await updateRegistry((r) => {
      const c = r.credentials.find((x) => x.id === verified.credential.id);
      if (c) c.counter = verified.newCounter;
    }).catch(() => {});
  }

  const session = newSession(verified.credential.role, "passkey", loaded.registry.sessionEpoch, verified.credential.id);
  const headers = new Headers();
  headers.append("set-cookie", sessionCookie(session));
  headers.append("set-cookie", clearChallengeCookie());
  return json({ role: session.role, csrf: csrfToken(session) }, { headers });
});
