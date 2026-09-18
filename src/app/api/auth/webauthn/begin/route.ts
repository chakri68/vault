import { api, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { challengeCookie } from "@/server/session";
import { authenticationOptions } from "@/server/webauthn";

export const POST = api({ auth: "public", limit: LIMITS.authWebauthn }, async ({ req }) => {
  const options = await authenticationOptions(req);
  return json(options, { headers: { "set-cookie": challengeCookie({ challenge: options.challenge, kind: "auth" }) } });
});
