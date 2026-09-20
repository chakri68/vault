import "server-only";
import { randomBytes } from "node:crypto";

/**
 * Server configuration. Nothing here can decrypt anything: if a variable would
 * let the server read a document, it doesn't belong in the environment (§31).
 */
export interface ServerEnv {
  storage:
    | { provider: "r2"; accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string }
    | { provider: "github"; token: string; owner: string; repo: string; branch: string }
    | { provider: "local-fs"; dir: string }
    | { provider: "unconfigured"; missing: string[] };
  sessionSecret: Buffer;
  /** true when SESSION_SECRET wasn't set and we made one up for this process */
  ephemeralSessionSecret: boolean;
  rpId: string | undefined;
  origin: string | undefined;
  maxObjectBytes: number;
  setupToken: string | undefined;
  production: boolean;
  commit: string | undefined;
}

const g = globalThis as unknown as { __fvEnv?: ServerEnv };

function read(): ServerEnv {
  const e = process.env;
  const production = e.NODE_ENV === "production";

  let storage: ServerEnv["storage"];
  // R2 first: during a migration both it and GitHub are configured at once, and
  // R2 is where we're going. Set STORAGE_PROVIDER to be explicit about it.
  const provider =
    e.STORAGE_PROVIDER ??
    (e.R2_ACCESS_KEY_ID ? "r2" : e.GITHUB_PAT || e.GITHUB_TOKEN ? "github" : "local-fs");
  if (provider === "r2") {
    const missing = [
      !e.R2_ACCOUNT_ID && "R2_ACCOUNT_ID",
      !e.R2_BUCKET && "R2_BUCKET",
      !e.R2_ACCESS_KEY_ID && "R2_ACCESS_KEY_ID",
      !e.R2_SECRET_ACCESS_KEY && "R2_SECRET_ACCESS_KEY",
    ].filter((x): x is string => !!x);
    storage = missing.length
      ? { provider: "unconfigured", missing }
      : {
          provider: "r2",
          accountId: e.R2_ACCOUNT_ID!,
          bucket: e.R2_BUCKET!,
          accessKeyId: e.R2_ACCESS_KEY_ID!,
          secretAccessKey: e.R2_SECRET_ACCESS_KEY!,
        };
  } else if (provider === "github") {
    const token = e.GITHUB_PAT ?? e.GITHUB_TOKEN;
    const missing = [
      !token && "GITHUB_PAT",
      !e.GITHUB_OWNER && "GITHUB_OWNER",
      !e.GITHUB_REPOSITORY && "GITHUB_REPOSITORY",
    ].filter((x): x is string => !!x);
    storage = missing.length
      ? { provider: "unconfigured", missing }
      : { provider: "github", token: token!, owner: e.GITHUB_OWNER!, repo: e.GITHUB_REPOSITORY!, branch: e.GITHUB_BRANCH ?? "main" };
  } else if (provider === "local-fs") {
    // A folder on the server's own disk. For development and self-hosting on a
    // box with a real filesystem; useless on serverless, where the disk is a rumour.
    storage = { provider: "local-fs", dir: e.LOCAL_STORE_DIR ?? ".vault-store" };
  } else {
    storage = { provider: "unconfigured", missing: [`STORAGE_PROVIDER=${provider} is not supported`] };
  }

  let sessionSecret: Buffer;
  let ephemeral = false;
  if (e.SESSION_SECRET && e.SESSION_SECRET.length >= 32) {
    sessionSecret = Buffer.from(e.SESSION_SECRET, "utf8");
  } else {
    if (production) throw new Error("SESSION_SECRET must be set to at least 32 characters in production");
    sessionSecret = randomBytes(32);
    ephemeral = true;
  }

  return {
    storage,
    sessionSecret,
    ephemeralSessionSecret: ephemeral,
    rpId: e.WEBAUTHN_RP_ID || undefined,
    origin: e.WEBAUTHN_ORIGIN || undefined,
    maxObjectBytes: Number(e.MAX_OBJECT_SIZE_MB ?? 50) * 1024 * 1024,
    setupToken: e.SETUP_TOKEN || undefined,
    production,
    commit: e.VERCEL_GIT_COMMIT_SHA ?? e.COMMIT_SHA ?? undefined,
  };
}

/** Cached on globalThis so a dev-mode module reload doesn't mint a new session secret. */
export function env(): ServerEnv {
  return (g.__fvEnv ??= read());
}
