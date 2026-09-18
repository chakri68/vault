/**
 * Spec §40, items 7–9 and friends, over real HTTP against a running server.
 *
 *   STORAGE_PROVIDER=local-fs LOCAL_STORE_DIR=<empty dir> npx next dev -p 3210
 *   FV_E2E_BASE=http://localhost:3210 npx vitest run src/server/api.e2e.test.ts
 *
 * Needs a fresh (uninitialised) store: it runs setup. Skipped otherwise.
 */
import { describe, expect, it } from "vitest";
import { ApiClient, HttpError } from "@/client/api";
import { importAesKey } from "@/crypto/aes";
import { type Bytes, newId, randomBytes, toBase64 } from "@/crypto/bytes";
import {
  createPasswordEnvelope, createRecoveryEnvelope, derivePasswordKeys, deriveRecoveryKeys,
  deriveWriteAuthKey, generateVmk, newVaultJson, unwrapVmk,
} from "@/crypto/envelopes";
import { fromBase64 } from "@/crypto/bytes";
import { generateRecoveryCode } from "@/crypto/recovery-code";
import { PreconditionFailedError } from "@/storage/provider";
import { VaultEngine } from "@/vault/engine";
import { MemoryLocalStore } from "@/vault/local-store";

const BASE = process.env.FV_E2E_BASE;
const PASSWORD = "mango tree monsoon kettle";

/** fetch with a cookie jar, and a spoofable client IP so rate-limit tests don't poison each other */
function browser(ip: string) {
  const jar = new Map<string, string>();
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-forwarded-for", ip);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq), value = pair.slice(eq + 1);
      if (value) jar.set(name, value); else jar.delete(name);
    }
    return res;
  };
  return { api: new ApiClient(fetchImpl, BASE), jar, fetchImpl };
}

const status = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : e instanceof PreconditionFailedError ? 412 : -1));

describe.skipIf(!BASE)("API security, over HTTP", () => {
  const vmk = generateVmk();
  let vaultId = "";
  let code = "";
  let admin: ReturnType<typeof browser>;

  it("sets up a vault, once", async () => {
    admin = browser("10.0.0.1");
    const config = await admin.api.config();
    expect(config.initialized, "needs a fresh store").toBe(false);

    vaultId = newId();
    code = await generateRecoveryCode();
    const pw = await createPasswordEnvelope(vmk, vaultId, PASSWORD);
    const rc = await createRecoveryEnvelope(vmk, vaultId, code);
    const body = {
      vaultJson: newVaultJson([pw.envelope, rc.envelope], vaultId),
      passwordAuthSecret: toBase64(pw.authSecret),
      recoveryAuthSecret: toBase64(rc.authSecret),
      writeAuthKey: toBase64(await deriveWriteAuthKey(vmk, vaultId)),
    };
    await admin.api.setup(body);
    expect(admin.api.role).toBe("admin");
    admin.api.setWriteAuthKey(await deriveWriteAuthKey(vmk, vaultId));

    // and never again: a second setup can't replace the vault
    expect(await status(browser("10.0.0.2").api.setup(body))).toBe(409);
  });

  it("the public config hands out salts, never wrapped keys", async () => {
    const res = await fetch(`${BASE}/api/vault/config`);
    const text = await res.text();
    const config = JSON.parse(text);
    expect(config.initialized).toBe(true);
    expect(config.kdf.salt).toBeTruthy();
    expect(text.includes("wrappedVmk")).toBe(false);
    expect(text.includes("envelopes")).toBe(false);
  });

  it("every route rejects a caller with no session (§40.7)", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/api/vault/meta"], ["GET", "/api/vault/index"], ["PUT", "/api/vault/index"],
      ["POST", "/api/vault/envelope"], ["GET", "/api/objects"], ["DELETE", "/api/objects"],
      ["GET", "/api/objects/part"], ["PUT", "/api/objects/part"], ["GET", "/api/objects/label"],
      ["PUT", "/api/objects/label"], ["GET", "/api/credentials"], ["POST", "/api/credentials/begin"],
      ["POST", "/api/credentials/finish"], ["DELETE", "/api/credentials/abc"], ["PATCH", "/api/credentials/abc"],
      ["POST", "/api/auth/logout"], ["GET", "/api/auth/session"], ["POST", "/api/auth/everywhere"],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(BASE + path, { method, body: method === "GET" ? undefined : "x", headers: { "x-forwarded-for": "10.0.1.1", "x-fv-object": newId() } });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("a forged or tampered session cookie is no session", async () => {
    const cookie = [...admin.jar][0];
    const [payload] = cookie[1].split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), role: "admin", sid: "x" })).toString("base64url");
    for (const value of [`${forged}.${cookie[1].split(".")[1]}`, `${payload}.AAAA`, "garbage"]) {
      const res = await fetch(`${BASE}/api/vault/index`, { headers: { cookie: `${cookie[0]}=${value}`, "x-forwarded-for": "10.0.1.2" } });
      expect(res.status).toBe(401);
    }
  });

  it("the index only moves by compare-and-swap", async () => {
    const engine = new VaultEngine({ remote: admin.api, local: new MemoryLocalStore(), vmk: await importAesKey(vmk) });
    await engine.open();
    await engine.addDocuments([{ content: randomBytes(1200), extension: "pdf", mimeType: "application/pdf", meta: { name: "Passport — Mom", ownerProfileIds: [], tags: [] } }]);

    const current = await admin.api.getIndex();
    expect(await status(admin.api.putIndex(current!.data, { ifMatch: "stale-version" }))).toBe(412);
    expect(await status(admin.api.putIndex(current!.data, {}))).toBe(412); // create-only, and it exists
    const raw = await admin.fetchImpl(`${BASE}/api/vault/index`, { method: "PUT", body: current!.data as BodyInit, headers: { "x-fv-csrf": admin.api.csrf! } });
    expect([403, 428]).toContain(raw.status); // no precondition, no write
  });

  it("a session alone can't write: it needs the CSRF token and proof of an unlocked vault", async () => {
    const id = newId();
    const part = new Uint8Array([0x46, 0x56, 0x4c, 0x54, ...randomBytes(200)]) as Bytes;

    const noCsrf = browser("10.0.0.1"); noCsrf.jar.set(...[...admin.jar][0]);
    noCsrf.api.setWriteAuthKey(await deriveWriteAuthKey(vmk, vaultId));
    expect(await status(noCsrf.api.putPart(id, 0, part))).toBe(403);

    const wrongKey = browser("10.0.0.1"); wrongKey.jar.set(...[...admin.jar][0]);
    wrongKey.api.csrf = admin.api.csrf;
    wrongKey.api.setWriteAuthKey(randomBytes(32));
    expect(await status(wrongKey.api.putPart(id, 0, part))).toBe(403);

    expect(await status(admin.api.putPart(id, 0, part))).toBe(200);
  });

  it("the password signs in as a member once an admin passkey exists — here, still admin — and wrong passwords all look alike", async () => {
    const config = await admin.api.config();
    const salt = fromBase64(config.kdf!.salt);

    const wrong = browser("10.0.2.1");
    const bad = await derivePasswordKeys("mango tree monsoon kettel", salt, config.kdf!.params);
    const a = await wrong.fetchImpl(`${BASE}/api/auth/password`, { method: "POST", body: JSON.stringify({ authSecret: toBase64(bad.authSecret) }) });
    const b = await wrong.fetchImpl(`${BASE}/api/auth/password`, { method: "POST", body: JSON.stringify({ authSecret: toBase64(randomBytes(32)) }) });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(await a.text()).toBe(await b.text());

    const good = browser("10.0.2.2");
    const keys = await derivePasswordKeys(PASSWORD, salt, config.kdf!.params);
    await good.api.authPassword(toBase64(keys.authSecret));
    const { vault } = await good.api.vaultJson();
    const unwrapped = await unwrapVmk(vault.envelopes.find((e) => e.kind === "password")!, keys.wrappingKey, vault.vaultId);
    expect(toBase64(unwrapped)).toBe(toBase64(vmk));
  });

  it("the recovery code signs in on its own, independent of the password", async () => {
    const config = await admin.api.config();
    const keys = await deriveRecoveryKeys(code, fromBase64(config.recoverySalt!));
    const b = browser("10.0.2.3");
    await b.api.authRecovery(toBase64(keys.authSecret));
    const { vault } = await b.api.vaultJson();
    const unwrapped = await unwrapVmk(vault.envelopes.find((e) => e.kind === "recovery-code")!, keys.wrappingKey, vault.vaultId);
    expect(toBase64(unwrapped)).toBe(toBase64(vmk));
  });

  it("deleting needs the current index version (§40.8)", async () => {
    const objects = await admin.api.listObjects();
    const victim = objects.find((o) => o.hasSidecar)!;
    expect(await status(admin.api.deleteObject(victim.id, "not-the-version"))).toBe(412);
    const raw = await admin.fetchImpl(`${BASE}/api/objects`, { method: "DELETE", headers: { "x-fv-csrf": admin.api.csrf!, "x-fv-object": victim.id } });
    expect([403, 428]).toContain(raw.status);
    expect((await admin.api.listObjects()).some((o) => o.id === victim.id)).toBe(true);

    const current = await admin.api.getIndex();
    expect(await status(admin.api.deleteObject(victim.id, current!.version))).toBe(200);
    expect((await admin.api.listObjects()).some((o) => o.id === victim.id)).toBe(false);
  });

  it("rejects paths and payloads that aren't what they claim", async () => {
    for (const bad of ["../../etc/passwd", "not-a-uuid", "00000000-0000-0000-0000-000000000000", "vault.json"]) {
      const res = await admin.fetchImpl(`${BASE}/api/objects/part`, { headers: { "x-fv-object": bad } });
      expect(res.status).toBe(400);
    }
    // JSON shaped like metadata is not a container
    const leak = new TextEncoder().encode(JSON.stringify({ filename: "passport.pdf", person: "Mom" })) as Bytes;
    expect(await status(admin.api.putPart(newId(), 0, leak))).toBe(400);
    expect(await status(admin.api.putPart(newId(), 99, leak))).toBe(400);
  });

  it("rate limiting engages on the password endpoint, and backs off (§40.9)", async () => {
    const attacker = browser("10.0.9.9");
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await attacker.fetchImpl(`${BASE}/api/auth/password`, { method: "POST", body: JSON.stringify({ authSecret: toBase64(randomBytes(32)) }) });
      codes.push(res.status);
      if (res.status === 429) expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);

    // even the right password is refused from that address now
    const config = await admin.api.config();
    const keys = await derivePasswordKeys(PASSWORD, fromBase64(config.kdf!.salt), config.kdf!.params);
    expect(await status(attacker.api.authPassword(toBase64(keys.authSecret)))).toBe(429);
  });

  it("logout ends the session", async () => {
    const config = await admin.api.config();
    const keys = await derivePasswordKeys(PASSWORD, fromBase64(config.kdf!.salt), config.kdf!.params);
    const b = browser("10.0.3.1");
    await b.api.authPassword(toBase64(keys.authSecret));
    expect(await status(b.api.listObjects())).toBe(200);
    await b.api.logout();
    expect(await status(b.api.listObjects())).toBe(401);
  });
});
