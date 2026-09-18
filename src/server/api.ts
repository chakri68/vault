import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { ZodError } from "zod";
import { isNotFound, isPreconditionFailed, isStorageUnavailable } from "@/storage/provider";
import { env } from "./env";
import { type Limit, hit, sweep } from "./rate-limit";
import { type Registry, loadRegistry } from "./registry";
import {
  type Session, csrfMatches, readSession, renew, sessionCookie, sessionCookieName, shouldRenew,
} from "./session";

type Bytes = Uint8Array<ArrayBuffer>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, public headers: Record<string, string> = {}) {
    super(code);
  }
}

export interface ApiContext<P> {
  req: NextRequest;
  params: P;
  ip: string;
  /** non-null whenever `auth` isn't "public" */
  session: Session | null;
  registry: Registry | null;
  body: Bytes;
  ifMatch: string | undefined;
}

export interface ApiOptions {
  /** every route except the public config needs a session (§6.2) */
  auth: "public" | "session" | "admin";
  limit: Limit;
  /**
   * For anything that changes the vault: CSRF token, plus an HMAC made with a
   * key derived from the unlocked VMK. A session cookie on its own can't
   * destroy anything; the caller also has to have actually opened the vault.
   */
  write?: boolean;
  /** CSRF without write-auth: for state changes that happen before unlock */
  csrf?: boolean;
  maxBody?: number;
}

const BASE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> | Headers } = {}): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) headers.set(k, v);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

/** Opaque bytes out, with the version token the client needs for its next compare-and-swap. */
export function binary(data: Bytes, version: string): Response {
  return new Response(data, {
    status: 200,
    headers: { ...BASE_HEADERS, "content-type": "application/octet-stream", "x-fv-version": version },
  });
}

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

export function writeAuthMessage(
  method: string, pathAndQuery: string, body: Uint8Array, ifMatch: string | undefined, object = "", part = "",
): string {
  // the object headers are signed too: they are the target of the write, just not in the URL
  return [method.toUpperCase(), pathAndQuery, createHash("sha256").update(body).digest("hex"), ifMatch ?? "", object, part].join("\n");
}

function verifyWriteAuth(registry: Registry, req: NextRequest, body: Bytes, ifMatch: string | undefined): boolean {
  const given = req.headers.get("x-fv-write-auth");
  if (!given) return false;
  const url = new URL(req.url);
  const expected = createHmac("sha256", Buffer.from(registry.writeAuthKey, "base64"))
    .update(writeAuthMessage(
      req.method, url.pathname + url.search, body, ifMatch,
      req.headers.get("x-fv-object") ?? "", req.headers.get("x-fv-part") ?? "",
    ))
    .digest();
  const actual = Buffer.from(given, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req: NextRequest, max: number): Promise<Bytes> {
  if (req.method === "GET" || req.method === "HEAD") return new Uint8Array(0);
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) throw new ApiError(413, "too-large");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > max) throw new ApiError(413, "too-large");
  return buf;
}

export function parseJson<T>(body: Bytes, schema: { parse(v: unknown): T }): T {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new ApiError(400, "bad-request");
  }
  return schema.parse(raw);
}

export function api<P = Record<string, never>>(
  opts: ApiOptions,
  handler: (ctx: ApiContext<P>) => Promise<Response>,
) {
  return async (req: NextRequest, routeCtx: { params: Promise<P> }): Promise<Response> => {
    try {
      const ip = clientIp(req);
      sweep();

      let session: Session | null = null;
      let registry: Registry | null = null;

      if (opts.auth !== "public") {
        session = readSession(req.cookies.get(sessionCookieName())?.value);
        if (!session) throw new ApiError(401, "unauthenticated");
        registry = (await loadRegistry())?.registry ?? null;
        const revoked =
          !registry ||
          session.epoch !== registry.sessionEpoch ||
          (session.cred !== undefined && !registry.credentials.some((c) => c.id === session!.cred));
        if (revoked) throw new ApiError(401, "unauthenticated");
      }

      // per-IP before auth, per-session after (§6.4)
      const wait = hit(opts.limit, session ? `s:${session.sid}` : `ip:${ip}`);
      if (wait > 0) throw new ApiError(429, "rate-limited", { "retry-after": String(wait) });

      // Members can read, upload and edit. Deleting, enrolling and reconfiguring are the admin's (§21.1).
      if (opts.auth === "admin" && session!.role !== "admin") throw new ApiError(403, "forbidden");

      const body = await readBody(req, opts.maxBody ?? 64 * 1024);
      const ifMatch = req.headers.get("if-match")?.replace(/^W\//, "").replace(/^"|"$/g, "") || undefined;

      if (opts.write || opts.csrf) {
        if (!session || !csrfMatches(session, req.headers.get("x-fv-csrf"))) throw new ApiError(403, "csrf");
      }
      if (opts.write && !verifyWriteAuth(registry!, req, body, ifMatch)) throw new ApiError(403, "write-auth");

      const res = await handler({ req, params: await routeCtx.params, ip, session, registry, body, ifMatch });

      if (session && shouldRenew(session) && !res.headers.has("set-cookie")) {
        res.headers.append("set-cookie", sessionCookie(renew(session)));
      }
      return res;
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code }, { status: e.status, headers: e.headers });
      if (isNotFound(e)) return json({ error: "not-found" }, { status: 404 });
      if (isPreconditionFailed(e)) return json({ error: "conflict" }, { status: 412 });
      if (e instanceof ZodError) return json({ error: "bad-request" }, { status: 400 });
      if (isStorageUnavailable(e)) {
        // our own wording, never a provider's response body
        return json({ error: "storage-unavailable", detail: e.message }, { status: 503 });
      }
      // Log the class of failure and nothing else: no body, no path, no object id (§6.6).
      if (!env().production) console.error("[api]", (e as Error)?.name, (e as Error)?.message);
      else console.error("[api] unexpected", (e as Error)?.name);
      return json({ error: "server" }, { status: 500 });
    }
  };
}
