import { api, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { challengeCookie } from "@/server/session";
import { registrationOptions } from "@/server/webauthn";

// A write here is several GitHub API calls in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

/**
 * Enrolment needs an unlocked vault (write-auth): the vault key has to be in
 * memory to be wrapped under the new credential. So: open the vault on the new
 * phone with the family password, then add its fingerprint.
 */
export const POST = api({ auth: "session", limit: LIMITS.credentials, write: true }, async ({ req, registry }) => {
  const options = await registrationOptions(req, registry!);
  return json(options, { headers: { "set-cookie": challengeCookie({ challenge: options.challenge, kind: "register" }) } });
});
