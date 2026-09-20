import "server-only";
import { GitHubStorageProvider } from "@/storage/github";
import { LocalFsStorageProvider } from "@/storage/local-fs";
import { R2StorageProvider } from "@/storage/r2";
import { type StorageProvider, StorageUnavailableError } from "@/storage/provider";
import { env } from "./env";

const g = globalThis as unknown as { __fvStore?: StorageProvider };

/** The primary store. One instance per process, so the provider's write queue actually serialises. */
export async function store(): Promise<StorageProvider> {
  const cfg = env().storage;
  if (cfg.provider === "unconfigured") {
    throw new StorageUnavailableError(`storage isn't configured: ${cfg.missing.join(", ")}`);
  }
  // In development a code reload replaces the class but not this cached instance,
  // which then quietly lacks whatever was just added. An instance of a class that
  // no longer exists gets rebuilt. In production the class never changes.
  const Provider =
    cfg.provider === "r2" ? R2StorageProvider
    : cfg.provider === "github" ? GitHubStorageProvider
    : LocalFsStorageProvider;
  if (!(g.__fvStore instanceof Provider)) {
    g.__fvStore =
      cfg.provider === "r2" ? new R2StorageProvider(cfg)
      : cfg.provider === "github" ? new GitHubStorageProvider(cfg)
      : new LocalFsStorageProvider(cfg.dir);
  }
  await g.__fvStore.connect();
  return g.__fvStore;
}

/**
 * `batching` is whether the store can stage blobs and land several files in one
 * write. Told to the client up front so it doesn't have to find out by having a
 * request refused: without it, the first upload after every worker restart posts
 * a body to /api/vault/stage only to be answered 501.
 *
 * Derived from the provider, not by asking the store, so this stays a pure read
 * of the environment and the public config route never opens a connection.
 */
export function storeDescription(): { provider: string; versioning: boolean; batching: boolean; location?: string; missing?: string[] } {
  const cfg = env().storage;
  if (cfg.provider === "r2") return { provider: "Cloudflare R2", versioning: false, batching: false, location: cfg.bucket };
  if (cfg.provider === "github") return { provider: "GitHub", versioning: true, batching: true, location: `${cfg.owner}/${cfg.repo}` };
  if (cfg.provider === "local-fs") return { provider: "A folder on this server", versioning: false, batching: false, location: cfg.dir };
  return { provider: "none", versioning: false, batching: false, missing: cfg.missing };
}
