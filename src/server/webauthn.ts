import "server-only";
import {
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { NextRequest } from "next/server";
import { ApiError } from "./api";
import { env } from "./env";
import type { RegisteredCredential, Registry } from "./registry";

/**
 * Server half of the passkey ceremony (§6.2). The same touch that gives the
 * client its PRF output gives the server this assertion: one prompt, two
 * independent results. The server never sees the PRF output.
 */
export function relyingParty(req: NextRequest): { rpID: string; origin: string } {
  const e = env();
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return {
    rpID: e.rpId ?? host.split(":")[0],
    origin: e.origin ?? `${proto}://${host}`,
  };
}

export function registrationOptions(req: NextRequest, registry: Registry) {
  return generateRegistrationOptions({
    rpName: "Family Vault",
    rpID: relyingParty(req).rpID,
    // one "user": the family. The handle is random and means nothing.
    userID: new Uint8Array(Buffer.from(registry.userHandle, "base64")),
    userName: "Family Vault",
    userDisplayName: "Family Vault",
    attestationType: "none",
    // discoverable, so unlock needs no credential list up front
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: registry.credentials.map((c) => ({
      id: c.id, transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
  });
}

export async function verifyRegistration(
  req: NextRequest,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<Omit<RegisteredCredential, "role" | "createdAt">> {
  const { rpID, origin } = relyingParty(req);
  const result = await verifyRegistrationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
  }).catch(() => null);
  if (!result?.verified || !result.registrationInfo) throw new ApiError(400, "webauthn-failed");
  const { credential } = result.registrationInfo;
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64"),
    counter: credential.counter,
    transports: credential.transports,
  };
}

export function authenticationOptions(req: NextRequest) {
  return generateAuthenticationOptions({
    rpID: relyingParty(req).rpID,
    userVerification: "required",
    allowCredentials: [],
  });
}

export async function verifyAuthentication(
  req: NextRequest,
  registry: Registry,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<{ credential: RegisteredCredential; newCounter: number }> {
  const credential = registry.credentials.find((c) => c.id === response.id);
  // same error whether the credential is unknown or the signature is bad
  if (!credential) throw new ApiError(401, "unauthenticated");
  const { rpID, origin } = relyingParty(req);
  const result = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: {
      id: credential.id,
      publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64")),
      counter: credential.counter,
      transports: credential.transports as AuthenticatorTransport[] | undefined,
    },
  }).catch(() => null);
  if (!result?.verified) throw new ApiError(401, "unauthenticated");
  return { credential, newCounter: result.authenticationInfo.newCounter };
}
