import "server-only";
import { type VaultJson, VaultJsonSchema } from "@/schemas/vault";
import { isNotFound } from "@/storage/provider";
import { VAULT_JSON_PATH } from "@/vault/index-model";
import { store } from "./store";

type Bytes = Uint8Array<ArrayBuffer>;

export async function readVaultJson(): Promise<{ vault: VaultJson; version: string; data: Bytes } | null> {
  try {
    const { data, version } = await (await store()).get(VAULT_JSON_PATH);
    return { vault: VaultJsonSchema.parse(JSON.parse(Buffer.from(data).toString("utf8"))), version, data };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export function encodeVaultJson(vault: VaultJson): Bytes {
  return new Uint8Array(Buffer.from(JSON.stringify(vault, null, 2), "utf8")) as Bytes;
}

export async function writeVaultJson(vault: VaultJson, ifMatch: string | undefined): Promise<string> {
  const opts = ifMatch ? { ifMatch } : ({ ifNoneMatch: "*" } as const);
  return (await (await store()).put(VAULT_JSON_PATH, encodeVaultJson(vault), opts)).version;
}
