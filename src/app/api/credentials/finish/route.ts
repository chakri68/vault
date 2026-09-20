import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { UnlockEnvelopeSchema } from "@/schemas/vault";
import { ApiError, api, json, parseJson } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";
import { updateRegistry } from "@/server/registry";
import { challengeCookieName, clearChallengeCookie, readChallenge } from "@/server/session";
import { readVaultJson, writeVaultJson } from "@/server/vault-files";
import { verifyRegistration } from "@/server/webauthn";

// A write here is a store round trip — on GitHub, six of them in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

const Body = z.object({
  response: z.looseObject({ id: z.string().max(1024), type: z.literal("public-key") }),
  envelope: UnlockEnvelopeSchema,
});

export const POST = api(
  { auth: "session", limit: LIMITS.credentials, write: true, maxBody: 64 * 1024 },
  async ({ req, body, session }) => {
    const { response, envelope } = parseJson(body, Body);
    const challenge = readChallenge(req.cookies.get(challengeCookieName())?.value, "register");
    if (!challenge) throw new ApiError(400, "webauthn-failed");
    const credential = await verifyRegistration(req, response as unknown as RegistrationResponseJSON, challenge);
    if (envelope.kind !== "passkey-prf" || envelope.credentialId !== credential.id) throw new ApiError(400, "bad-request");

    // The envelope first. A key that unlocks but can't sign in yet is a retry; the reverse is a lockout-shaped bug.
    for (let attempt = 0; ; attempt++) {
      const current = await readVaultJson(true);
      if (!current) throw new ApiError(404, "not-found");
      const envelopes = [...current.vault.envelopes.filter((e) => e.credentialId !== credential.id), envelope];
      try {
        await writeVaultJson({ ...current.vault, envelopes }, current.version);
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
      }
    }
    // A member can add their own phone, as a member. Only an admin mints another admin.
    const role = session!.role === "admin" ? "admin" : "member";
    await updateRegistry((r) => {
      r.credentials = r.credentials.filter((c) => c.id !== credential.id);
      r.credentials.push({ ...credential, role, createdAt: new Date().toISOString() });
    });
    return json({ ok: true, role }, { headers: { "set-cookie": clearChallengeCookie() } });
  },
);
