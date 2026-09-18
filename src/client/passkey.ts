import { type Bytes, asBytes, fromBase64, fromBase64Url, toBase64Url } from "@/crypto/bytes";

/**
 * WebAuthn ceremonies. These have to run on the page (the worker has no
 * `navigator.credentials`), so this is the one place key-ish material — the PRF
 * output — touches the main thread. It goes straight to the worker and the
 * local copy is zeroed by the caller.
 */

export type Platform = "android" | "iphone" | "ipad" | "mac" | "windows" | "other";

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPod/i.test(ua)) return "iphone";
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "ipad";
  if (/Macintosh/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  return "other";
}

/** Say what the platform says. Never "passkey" on the lock screen. */
export function unlockWords(p = detectPlatform()): { unlock: string; add: string; noun: string; device: string } {
  switch (p) {
    case "android": return { unlock: "Unlock with fingerprint", add: "Add this phone's fingerprint", noun: "fingerprint", device: "phone" };
    case "iphone": return { unlock: "Unlock with Face ID", add: "Add this iPhone's Face ID", noun: "Face ID", device: "iPhone" };
    case "ipad": return { unlock: "Unlock with Touch ID", add: "Add this iPad's Touch ID", noun: "Touch ID", device: "iPad" };
    case "mac": return { unlock: "Unlock with Touch ID", add: "Add this Mac's Touch ID", noun: "Touch ID", device: "Mac" };
    case "windows": return { unlock: "Unlock with Windows Hello", add: "Add Windows Hello on this PC", noun: "Windows Hello", device: "PC" };
    default: return { unlock: "Unlock with this device", add: "Add this device's screen lock", noun: "screen lock", device: "device" };
  }
}

export function suggestedDeviceLabel(p = detectPlatform()): string {
  return { android: "Android phone", iphone: "iPhone", ipad: "iPad", mac: "Mac", windows: "Windows PC", other: "This device" }[p];
}

export async function passkeysAvailable(): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

const b64url = (v: ArrayBuffer | null | undefined) => (v ? toBase64Url(new Uint8Array(v)) : undefined);

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };

function prfOutput(cred: PublicKeyCredential): { enabled: boolean; output: Bytes | null } {
  const prf = (cred.getClientExtensionResults() as { prf?: PrfResults }).prf;
  const first = prf?.results?.first;
  return { enabled: !!prf?.enabled || !!first, output: first ? asBytes(first as ArrayBuffer | ArrayBufferView).slice() as Bytes : null };
}

export class PasskeyCancelled extends Error {}
/** The authenticator works, but can't derive the secret we need (§5.1: fall back to the password, and say so). */
export class PrfUnsupported extends Error {}

async function guard<T>(fn: () => Promise<T | null>): Promise<T> {
  try {
    const out = await fn();
    if (!out) throw new PasskeyCancelled();
    return out;
  } catch (e) {
    if (e instanceof PrfUnsupported) throw e;
    if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) throw new PasskeyCancelled();
    throw e;
  }
}

export interface AssertionResult {
  response: { id: string } & Record<string, unknown>;
  prfOutput: Bytes;
}

/** One touch, two outcomes: an assertion for the server and a PRF secret for the vault (§6.2). */
export async function getAssertion(
  options: Record<string, unknown>,
  prfSalt: string,
  onlyCredentialId?: string,
): Promise<AssertionResult> {
  const o = options as {
    challenge: string; rpId?: string; timeout?: number; userVerification?: UserVerificationRequirement;
    allowCredentials?: Array<{ id: string; type?: string; transports?: AuthenticatorTransport[] }>;
  };
  const allow = onlyCredentialId ? [{ id: onlyCredentialId }] : (o.allowCredentials ?? []);
  const cred = await guard(() => navigator.credentials.get({
    publicKey: {
      challenge: fromBase64Url(o.challenge),
      rpId: o.rpId,
      timeout: o.timeout,
      userVerification: o.userVerification ?? "required",
      allowCredentials: allow.map((c) => ({ id: fromBase64Url(c.id), type: "public-key" as const, transports: c.transports })),
      extensions: { prf: { eval: { first: fromBase64(prfSalt) } } } as AuthenticationExtensionsClientInputs,
    },
  }) as Promise<PublicKeyCredential | null>);

  const { output } = prfOutput(cred);
  if (!output) throw new PrfUnsupported();
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    prfOutput: output,
    response: {
      id: cred.id, rawId: b64url(cred.rawId), type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(r.clientDataJSON), authenticatorData: b64url(r.authenticatorData),
        signature: b64url(r.signature), userHandle: b64url(r.userHandle),
      },
    },
  };
}

export interface RegistrationResult {
  response: { id: string } & Record<string, unknown>;
  prfOutput: Bytes;
}

/**
 * Registers a passkey and gets its PRF output. Some authenticators hand the
 * output back at creation; many only say "enabled" and need one assertion to
 * produce it, which means a second prompt. Either way, no PRF means no passkey
 * unlock on this device — we don't invent a fallback key with nowhere safe to live.
 */
export async function createCredential(options: Record<string, unknown>, prfSalt: string): Promise<RegistrationResult> {
  const o = options as {
    challenge: string; rp: PublicKeyCredentialRpEntity; user: { id: string; name: string; displayName: string };
    pubKeyCredParams: PublicKeyCredentialParameters[]; timeout?: number; attestation?: AttestationConveyancePreference;
    authenticatorSelection?: AuthenticatorSelectionCriteria;
    excludeCredentials?: Array<{ id: string; transports?: AuthenticatorTransport[] }>;
  };
  const salt = fromBase64(prfSalt);
  const cred = await guard(() => navigator.credentials.create({
    publicKey: {
      challenge: fromBase64Url(o.challenge),
      rp: o.rp,
      user: { ...o.user, id: fromBase64Url(o.user.id) },
      pubKeyCredParams: o.pubKeyCredParams,
      timeout: o.timeout,
      attestation: o.attestation,
      authenticatorSelection: o.authenticatorSelection,
      excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ id: fromBase64Url(c.id), type: "public-key" as const, transports: c.transports })),
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  }) as Promise<PublicKeyCredential | null>);

  const r = cred.response as AuthenticatorAttestationResponse;
  const response = {
    id: cred.id, rawId: b64url(cred.rawId), type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(r.clientDataJSON), attestationObject: b64url(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
  };

  const prf = prfOutput(cred);
  if (prf.output) return { response, prfOutput: prf.output };
  if (!prf.enabled) throw new PrfUnsupported();

  // enabled, but silent at creation: ask once more, for this credential only
  const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const follow = await getAssertion({ challenge, rpId: o.rp.id, userVerification: "required" }, prfSalt, cred.id);
  return { response, prfOutput: follow.prfOutput };
}
