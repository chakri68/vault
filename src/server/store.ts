import "server-only";
import { GitHubStorageProvider } from "@/storage/github";
import { LocalFsStorageProvider } from "@/storage/local-fs";
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
  const Provider = cfg.provider === "github" ? GitHubStorageProvider : LocalFsStorageProvider;
  if (!(g.__fvStore instanceof Provider)) {
    g.__fvStore = cfg.provider === "github" ? new GitHubStorageProvider(cfg) : new LocalFsStorageProvider(cfg.dir);
  }
  await g.__fvStore.connect();
  return g.__fvStore;
}

export function storeDescription(): { provider: string; versioning: boolean; location?: string; missing?: string[] } {
  const cfg = env().storage;
  if (cfg.provider === "github") return { provider: "GitHub", versioning: true, location: `${cfg.owner}/${cfg.repo}` };
  if (cfg.provider === "local-fs") return { provider: "A folder on this server", versioning: false, location: cfg.dir };
  return { provider: "none", versioning: false, missing: cfg.missing };
}
