import { api, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { challengeCookie } from "@/server/session";
import { authenticationOptions } from "@/server/webauthn";

// A write here is several GitHub API calls in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

export const POST = api({ auth: "public", limit: LIMITS.authWebauthn }, async ({ req }) => {
  const options = await authenticationOptions(req);
  return json(options, { headers: { "set-cookie": challengeCookie({ challenge: options.challenge, kind: "auth" }) } });
});
