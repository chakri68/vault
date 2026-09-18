import { PreconditionFailedError, type StorageProvider, parseObjectPath, isNotFound, isPreconditionFailed } from "@/storage/provider";
import { INDEX_PATH, objectPath, sidecarPath } from "./index-model";

type Bytes = Uint8Array<ArrayBuffer>;

/**
 * What the engine needs from "the store", whether that's the HTTP API (in the
 * browser) or a provider directly (tests, backup restore). Deals only in
 * opaque ids and ciphertext.
 */
export interface VaultRemote {
  getIndex(): Promise<{ data: Bytes; version: string } | null>;
  /** `ifMatch` undefined means create-only. Throws PreconditionFailedError on a lost race. */
  putIndex(data: Bytes, opts: { ifMatch?: string }): Promise<{ version: string }>;

  getPart(id: string, part: number): Promise<Bytes>;
  /** Content is immutable: create-only, and re-sending an existing part is a no-op. */
  putPart(id: string, part: number, data: Bytes): Promise<void>;

  getSidecar(id: string): Promise<{ data: Bytes; version: string } | null>;
  putSidecar(id: string, data: Bytes, opts: { ifMatch?: string }): Promise<{ version: string }>;

  /** Removes every part and the sidecar. Needs the current index version as proof of a live, unlocked client. */
  deleteObject(id: string, indexVersion: string): Promise<void>;

  listObjects(): Promise<StoredObject[]>;
}

export interface StoredObject {
  id: string;
  parts: number;
  size: number;
  hasSidecar: boolean;
}

/** Groups a flat provider listing into objects. Shared by the server route and the tests. */
export function groupObjects(items: Array<{ path: string; size: number }>): StoredObject[] {
  const byId = new Map<string, StoredObject>();
  for (const item of items) {
    const parsed = parseObjectPath(item.path);
    if (!parsed) continue;
    let o = byId.get(parsed.id);
    if (!o) byId.set(parsed.id, (o = { id: parsed.id, parts: 0, size: 0, hasSidecar: false }));
    if (parsed.kind === "meta") o.hasSidecar = true;
    else {
      o.parts += 1;
      o.size += item.size;
    }
  }
  return [...byId.values()];
}

export async function deleteObjectFiles(provider: StorageProvider, id: string): Promise<void> {
  const paths = (await provider.list(`objects/${id}`))
    .map((item) => item.path)
    .filter((path) => parseObjectPath(path)?.id === id);
  // one commit for the lot where the provider can (GitHub), so a delete is atomic there
  const batch = (provider as { deleteMany?: (paths: string[]) => Promise<void> }).deleteMany;
  if (batch) await batch.call(provider, paths);
  else for (const path of paths) await provider.delete(path);
}

/** Runs the engine straight against a provider, no HTTP in between. */
export class ProviderRemote implements VaultRemote {
  constructor(private provider: StorageProvider) {}

  private async getOrNull(path: string) {
    try {
      return await this.provider.get(path);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  getIndex() {
    return this.getOrNull(INDEX_PATH);
  }

  putIndex(data: Bytes, opts: { ifMatch?: string }) {
    return this.provider.put(INDEX_PATH, data, opts.ifMatch ? { ifMatch: opts.ifMatch } : { ifNoneMatch: "*" });
  }

  async getPart(id: string, part: number) {
    return (await this.provider.get(objectPath(id, part))).data;
  }

  async putPart(id: string, part: number, data: Bytes) {
    try {
      await this.provider.put(objectPath(id, part), data, { ifNoneMatch: "*" });
    } catch (e) {
      if (!isPreconditionFailed(e)) throw e;
    }
  }

  getSidecar(id: string) {
    return this.getOrNull(sidecarPath(id));
  }

  putSidecar(id: string, data: Bytes, opts: { ifMatch?: string }) {
    return this.provider.put(sidecarPath(id), data, opts.ifMatch ? { ifMatch: opts.ifMatch } : { ifNoneMatch: "*" });
  }

  async deleteObject(id: string, indexVersion: string) {
    const current = await this.getOrNull(INDEX_PATH);
    if (!current || current.version !== indexVersion) throw new PreconditionFailedError();
    await deleteObjectFiles(this.provider, id);
  }

  async listObjects() {
    return groupObjects(await this.provider.list("objects/"));
  }
}
