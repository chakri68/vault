import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * §6.3. The session proves "you may touch this store". It says nothing about
 * reading what's in it — that's the vault unlock, which the server never sees.
 *
 * Stateless on purpose: a serverless function has nowhere to keep a session
 * table. The cookie is an HMAC-signed claim, and revocation works through the
 * registry instead — every session carries the epoch it was issued under, and
 * bumping the epoch ("sign out everywhere") or removing a credential voids it.
 */
export type Role = "admin" | "member";

export interface Session {
  sid: string;
  role: Role;
  via: "password" | "passkey" | "recovery" | "setup";
  /** credential id, for passkey sessions: removing the credential ends them */
  cred?: string;
  epoch: number;
  iat: number;
  exp: number;
}

const LIFETIME_MS = 24 * 60 * 60 * 1000;
const RENEW_BELOW_MS = LIFETIME_MS / 2;

export const sessionCookieName = () => (env().production ? "__Host-fv_session" : "fv_session");
export const challengeCookieName = () => (env().production ? "__Host-fv_wa" : "fv_wa");

function sign(payload: string, purpose: string): string {
  return createHmac("sha256", env().sessionSecret).update(`${purpose}:${payload}`).digest("base64url");
}

function seal(data: object, purpose: string): string {
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  return `${payload}.${sign(payload, purpose)}`;
}

function unseal<T>(token: string | undefined, purpose: string): T | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(payload, purpose), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function newSession(role: Role, via: Session["via"], epoch: number, cred?: string): Session {
  const now = Date.now();
  return { sid: randomUUID(), role, via, cred, epoch, iat: now, exp: now + LIFETIME_MS };
}

export function readSession(token: string | undefined): Session | null {
  const s = unseal<Session>(token, "session");
  if (!s || typeof s.exp !== "number" || s.exp < Date.now()) return null;
  return s;
}

export function shouldRenew(s: Session): boolean {
  return s.exp - Date.now() < RENEW_BELOW_MS;
}

export function renew(s: Session): Session {
  return { ...s, exp: Date.now() + LIFETIME_MS };
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  // HttpOnly: script can't read it. SameSite=Strict: it isn't sent on any
  // cross-site request. Never in localStorage.
  return [
    `${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`,
    ...(env().production ? ["Secure"] : []),
  ].join("; ");
}

export const sessionCookie = (s: Session) => cookie(sessionCookieName(), seal(s, "session"), Math.floor(LIFETIME_MS / 1000));
export const clearSessionCookie = () => cookie(sessionCookieName(), "", 0);

/**
 * CSRF token: delivered in a response body, sent back in a header. Derived from
 * the session id, so there's nothing to store and it dies with the session.
 */
export function csrfToken(s: Session): string {
  return sign(s.sid, "csrf");
}

export function csrfMatches(s: Session, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(csrfToken(s));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** WebAuthn challenge, parked in a short-lived signed cookie between begin and finish. */
export interface PendingChallenge {
  challenge: string;
  kind: "auth" | "register";
  exp: number;
}

export const challengeCookie = (c: Omit<PendingChallenge, "exp">) =>
  cookie(challengeCookieName(), seal({ ...c, exp: Date.now() + 5 * 60_000 }, "webauthn"), 300);
export const clearChallengeCookie = () => cookie(challengeCookieName(), "", 0);

export function readChallenge(token: string | undefined, kind: PendingChallenge["kind"]): string | null {
  const c = unseal<PendingChallenge>(token, "webauthn");
  if (!c || c.kind !== kind || c.exp < Date.now()) return null;
  return c.challenge;
}

/**
 * A staged blob is just a git sha, and a sha says nothing about what it was
 * checked as. The token binds it to the slot it was validated for, so bytes
 * staged as a document part can't be committed as the index.
 */
export function stageToken(slot: string, sha: string): string {
  return `${sha}.${sign(`${slot}|${sha}`, "stage")}`;
}

export function readStageToken(slot: string, token: string): string | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const sha = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(`${slot}|${sha}`, "stage"));
  return /^[0-9a-f]{40,64}$/.test(sha) && a.length === b.length && timingSafeEqual(a, b) ? sha : null;
}
