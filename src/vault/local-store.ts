type Bytes = Uint8Array<ArrayBuffer>;

/**
 * What lives on the device. Ciphertext and opaque ids only — the same bytes the
 * untrusted store holds (§5.5, §17.1). A stolen locked phone yields what a
 * stolen repository clone yields.
 */
export interface LocalStore {
  getObject(id: string): Promise<Bytes[] | undefined>;
  putObject(id: string, parts: Bytes[]): Promise<void>;
  getSidecar(id: string): Promise<Bytes | undefined>;
  putSidecar(id: string, data: Bytes): Promise<void>;
  deleteObject(id: string): Promise<void>;
  /** ids whose content is fully on this device */
  objectIds(): Promise<Set<string>>;
  /** bytes used by cached objects */
  usage(): Promise<number>;

  getBlob(key: string): Promise<Bytes | undefined>;
  putBlob(key: string, data: Bytes): Promise<void>;
  deleteBlob(key: string): Promise<void>;
}

/** Well-known blob keys. */
export const BLOB = {
  vaultJson: "vault.json",
  /** last index.vault seen on the remote, as-is */
  remoteIndex: "index.remote",
  remoteIndexVersion: "index.remote.version",
  /** the local working index, sealed, when it's ahead of the remote */
  pendingIndex: "index.pending",
  /** which ids still need pushing: opaque uuids only */
  dirty: "dirty.json",
} as const;

export class MemoryLocalStore implements LocalStore {
  objects = new Map<string, Bytes[]>();
  sidecars = new Map<string, Bytes>();
  blobs = new Map<string, Bytes>();

  async getObject(id: string) { return this.objects.get(id); }
  async putObject(id: string, parts: Bytes[]) { this.objects.set(id, parts); }
  async getSidecar(id: string) { return this.sidecars.get(id); }
  async putSidecar(id: string, data: Bytes) { this.sidecars.set(id, data); }
  async deleteObject(id: string) { this.objects.delete(id); this.sidecars.delete(id); }
  async objectIds() { return new Set(this.objects.keys()); }
  async usage() {
    let n = 0;
    for (const parts of this.objects.values()) for (const p of parts) n += p.length;
    return n;
  }
  async getBlob(key: string) { return this.blobs.get(key); }
  async putBlob(key: string, data: Bytes) { this.blobs.set(key, data); }
  async deleteBlob(key: string) { this.blobs.delete(key); }
}
