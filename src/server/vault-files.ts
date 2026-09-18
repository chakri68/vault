import "server-only";
import { type VaultJson, VaultJsonSchema } from "@/schemas/vault";
import { isNotFound } from "@/storage/provider";
import { VAULT_JSON_PATH } from "@/vault/index-model";
import { store } from "./store";

type Bytes = Uint8Array<ArrayBuffer>;

type Loaded = { vault: VaultJson; version: string; data: Bytes };
const g = globalThis as unknown as { __fvVaultJson?: { value: Loaded | null; at: number } };
const TTL_MS = 30_000;

/**
 * Cached briefly: it's read on every page load and every unlock, and it only
 * changes when a device is added or a password replaced. Anything about to
 * *write* it passes `fresh`, so its compare-and-swap is against the real thing.
 */
export async function readVaultJson(fresh = false): Promise<Loaded | null> {
  const cached = g.__fvVaultJson;
  // "there is no vault yet" is never cached: setup has to see the moment that changes
  if (!fresh && cached?.value && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    const { data, version } = await (await store()).get(VAULT_JSON_PATH);
    const value = { vault: VaultJsonSchema.parse(JSON.parse(Buffer.from(data).toString("utf8"))), version, data };
    g.__fvVaultJson = { value, at: Date.now() };
    return value;
  } catch (e) {
    if (isNotFound(e)) {
      g.__fvVaultJson = undefined;
      return null;
    }
    throw e;
  }
}

export function encodeVaultJson(vault: VaultJson): Bytes {
  return new Uint8Array(Buffer.from(JSON.stringify(vault, null, 2), "utf8")) as Bytes;
}

export async function writeVaultJson(vault: VaultJson, ifMatch: string | undefined): Promise<string> {
  const opts = ifMatch ? { ifMatch } : ({ ifNoneMatch: "*" } as const);
  const data = encodeVaultJson(vault);
  const version = (await (await store()).put(VAULT_JSON_PATH, data, opts)).version;
  g.__fvVaultJson = { value: { vault, version, data }, at: Date.now() };
  return version;
}
