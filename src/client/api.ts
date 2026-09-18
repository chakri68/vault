import { type Bytes, asBytes, toBase64Url, toHex, utf8 } from "@/crypto/bytes";
import { sha256 } from "@/crypto/checksum";
import { hmacSha256 } from "@/crypto/hkdf";
import { type VaultJson, VaultJsonSchema } from "@/schemas/vault";
import type { KdfParams } from "@/crypto/kdf";
import { NotFoundError, PreconditionFailedError, isNotFound } from "@/storage/provider";
import type { StoredObject, VaultRemote } from "@/vault/remote";

export interface PublicConfig {
  initialized: boolean | null;
  storage: { ok: boolean; provider?: string; versioning?: boolean; location?: string; problem?: string; missing?: string[] };
  rpId: string;
  maxObjectBytes: number;
  setupTokenRequired: boolean;
  commit: string | null;
  formatVersion?: number;
  vaultId?: string;
  kdf?: { params: KdfParams; salt: string } | null;
  recoverySalt?: string | null;
  prfSalt?: string;
  hasPasskeys?: boolean;
}

export type Role = "admin" | "member";

export class HttpError extends Error {
  constructor(public status: number, public code: string, public retryAfter?: number, public detail?: string) {
    super(`${status} ${code}`);
    this.name = "HttpError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The browser's side of the API. Everything it sends is ciphertext, an opaque
 * id, or a secret the server can verify but not use. Also the engine's
 * VaultRemote, so the same engine that the tests run against a provider runs
 * here against HTTP.
 */
export class ApiClient implements VaultRemote {
  csrf: string | null = null;
  role: Role | null = null;
  /** K_w, derived from the unlocked vault key. Signs every write. */
  private writeAuthKey: Bytes | null = null;

  constructor(private fetchImpl: FetchLike = (i, init) => fetch(i, init), private base = "") {}

  setWriteAuthKey(key: Bytes | null) {
    this.writeAuthKey = key;
  }

  clear() {
    this.csrf = null;
    this.role = null;
    this.writeAuthKey?.fill(0);
    this.writeAuthKey = null;
  }

  // ───────────────────────── plumbing ─────────────────────────

  private async call(
    method: string,
    path: string,
    opts: {
      body?: Bytes | object; write?: boolean; ifMatch?: string; ifNoneMatch?: "*"; csrf?: boolean;
      /** which object this is about. A header, not the URL: hosts log URLs. */
      object?: string; part?: number;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.object) headers["x-fv-object"] = opts.object;
    if (opts.part !== undefined) headers["x-fv-part"] = String(opts.part);
    let body: Bytes | undefined;
    if (opts.body instanceof Uint8Array) {
      body = opts.body;
      headers["content-type"] = "application/octet-stream";
    } else if (opts.body) {
      body = utf8(JSON.stringify(opts.body));
      headers["content-type"] = "application/json";
    }
    if (opts.ifMatch) headers["if-match"] = opts.ifMatch;
    if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;
    if ((opts.write || opts.csrf) && this.csrf) headers["x-fv-csrf"] = this.csrf;
    if (opts.write) {
      if (!this.writeAuthKey) throw new HttpError(403, "locked");
      const digest = toHex(await sha256(body ?? asBytes(new Uint8Array(0))));
      const message = [method, path, digest, opts.ifMatch ?? "", opts.object ?? "", opts.part === undefined ? "" : String(opts.part)].join("\n");
      headers["x-fv-write-auth"] = toBase64Url(await hmacSha256(this.writeAuthKey, utf8(message)));
    }

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(this.base + path, { method, headers, body, credentials: "same-origin", cache: "no-store" });
      if (res.ok) return res;
      const info = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      // a short rate-limit wait is ours to absorb; a long one is the caller's to explain
      if (res.status === 429 && retryAfter > 0 && retryAfter <= 20 && attempt < 3) {
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (res.status === 404) throw new NotFoundError();
      if (res.status === 412) throw new PreconditionFailedError();
      throw new HttpError(res.status, info.error ?? "error", retryAfter || undefined, info.detail);
    }
  }

  private async bytes(res: Response): Promise<{ data: Bytes; version: string }> {
    return { data: asBytes(await res.arrayBuffer()), version: res.headers.get("x-fv-version") ?? "" };
  }

  private async orNull<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  private adopt(session: { role: Role; csrf: string }) {
    this.role = session.role;
    this.csrf = session.csrf;
  }

  // ───────────────────────── auth ─────────────────────────

  async config(): Promise<PublicConfig> {
    return (await this.call("GET", "/api/vault/config")).json();
  }

  async setup(body: {
    setupToken?: string; mode?: "create" | "restore"; vaultJson: VaultJson;
    passwordAuthSecret?: string; recoveryAuthSecret?: string; writeAuthKey: string;
  }): Promise<void> {
    this.adopt(await (await this.call("POST", "/api/setup", { body })).json());
  }

  async authPassword(authSecret: string): Promise<void> {
    this.adopt(await (await this.call("POST", "/api/auth/password", { body: { authSecret } })).json());
  }

  async authRecovery(authSecret: string): Promise<void> {
    this.adopt(await (await this.call("POST", "/api/auth/recovery", { body: { authSecret } })).json());
  }

  async webauthnBegin(): Promise<unknown> {
    return (await this.call("POST", "/api/auth/webauthn/begin")).json();
  }

  async webauthnFinish(response: unknown): Promise<void> {
    this.adopt(await (await this.call("POST", "/api/auth/webauthn/finish", { body: { response } })).json());
  }

  async logout(): Promise<void> {
    await this.call("POST", "/api/auth/logout", { csrf: true }).catch(() => {});
    this.csrf = null;
    this.role = null;
  }

  async signOutEverywhere(): Promise<void> {
    await this.call("POST", "/api/auth/everywhere", { write: true });
  }

  async vaultJson(): Promise<{ vault: VaultJson; version: string; data: Bytes }> {
    const { data, version } = await this.bytes(await this.call("GET", "/api/vault/meta"));
    return { vault: VaultJsonSchema.parse(JSON.parse(new TextDecoder().decode(data))), version, data };
  }

  /** Swaps the password envelope or the recovery-code envelope, and the login hash that goes with it. */
  async replaceEnvelope(kind: "password" | "recovery-code", vaultJson: VaultJson, authSecret: string, ifMatch: string): Promise<void> {
    await this.call("POST", "/api/vault/envelope", { body: { kind, vaultJson, authSecret }, write: true, ifMatch });
  }

  async credentials(): Promise<{ current: string | null; credentials: Array<{ id: string; role: Role; createdAt: string }> }> {
    return (await this.call("GET", "/api/credentials")).json();
  }

  async enrolBegin(): Promise<unknown> {
    return (await this.call("POST", "/api/credentials/begin", { write: true })).json();
  }

  async enrolFinish(response: unknown, envelope: unknown): Promise<{ role: Role }> {
    return (await this.call("POST", "/api/credentials/finish", { body: { response, envelope }, write: true })).json();
  }

  async removeCredential(id: string): Promise<void> {
    await this.call("DELETE", `/api/credentials/${encodeURIComponent(id)}`, { write: true });
  }

  async setCredentialRole(id: string, role: Role): Promise<void> {
    await this.call("PATCH", `/api/credentials/${encodeURIComponent(id)}`, { body: { role }, write: true });
  }

  // ───────────────────────── VaultRemote ─────────────────────────

  getIndex() {
    return this.orNull(this.call("GET", "/api/vault/index").then((r) => this.bytes(r)));
  }

  async putIndex(data: Bytes, opts: { ifMatch?: string }) {
    const res = await this.call("PUT", "/api/vault/index", {
      body: data, write: true, ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : { ifNoneMatch: "*" as const }),
    });
    return (await res.json()) as { version: string };
  }

  async getPart(id: string, part: number) {
    return (await this.bytes(await this.call("GET", "/api/objects/part", { object: id, part }))).data;
  }

  async putPart(id: string, part: number, data: Bytes) {
    await this.call("PUT", "/api/objects/part", { body: data, write: true, object: id, part });
  }

  getSidecar(id: string) {
    return this.orNull(this.call("GET", "/api/objects/label", { object: id }).then((r) => this.bytes(r)));
  }

  async putSidecar(id: string, data: Bytes, opts: { ifMatch?: string }) {
    const res = await this.call("PUT", "/api/objects/label", {
      object: id, body: data, write: true, ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : { ifNoneMatch: "*" as const }),
    });
    return (await res.json()) as { version: string };
  }

  async deleteObject(id: string, indexVersion: string) {
    await this.call("DELETE", "/api/objects", { write: true, ifMatch: indexVersion, object: id });
  }

  async listObjects(): Promise<StoredObject[]> {
    return ((await (await this.call("GET", "/api/objects")).json()) as { objects: StoredObject[] }).objects;
  }
}
