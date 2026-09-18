import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { LocalStore } from "@/vault/local-store";

type Bytes = Uint8Array<ArrayBuffer>;

interface Schema extends DBSchema {
  /** object ciphertext, one record per storage part */
  parts: { key: [string, number]; value: { id: string; part: number; data: ArrayBuffer } };
  /** which objects are complete on this device, and how big */
  objects: { key: string; value: { id: string; parts: number; bytes: number; cachedAt: number } };
  sidecars: { key: string; value: { id: string; data: ArrayBuffer } };
  /** vault.json, the sealed index copies, the dirty list, UI-free prefs */
  blobs: { key: string; value: { key: string; data: ArrayBuffer } };
}

const DB_NAME = "family-vault";

/**
 * §17.1. The offline cache. What's in here is what's in the untrusted store:
 * ciphertext, sealed blobs and opaque ids. No key, no decrypted index, no
 * plaintext — so a stolen locked phone yields what a stolen repo clone yields.
 *
 * iOS may evict this when the app goes unused for a while (§18.1). That's why
 * it is a cache and never the only copy — except for uploads made offline,
 * which the engine refuses to evict until they've reached the store.
 */
export class IdbLocalStore implements LocalStore {
  private db: Promise<IDBPDatabase<Schema>>;

  constructor(name = DB_NAME) {
    this.db = openDB<Schema>(name, 1, {
      upgrade(db) {
        db.createObjectStore("parts", { keyPath: ["id", "part"] });
        db.createObjectStore("objects", { keyPath: "id" });
        db.createObjectStore("sidecars", { keyPath: "id" });
        db.createObjectStore("blobs", { keyPath: "key" });
      },
    });
  }

  private static buf(data: Bytes): ArrayBuffer {
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }

  async getObject(id: string): Promise<Bytes[] | undefined> {
    const db = await this.db;
    const meta = await db.get("objects", id);
    if (!meta) return undefined;
    const tx = db.transaction("parts");
    const parts = await Promise.all(Array.from({ length: meta.parts }, (_, i) => tx.store.get([id, i])));
    if (parts.some((p) => !p)) return undefined; // partly evicted: treat as a miss
    return parts.map((p) => new Uint8Array(p!.data) as Bytes);
  }

  async putObject(id: string, parts: Bytes[]): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(["parts", "objects"], "readwrite");
    let bytes = 0;
    parts.forEach((data, part) => {
      bytes += data.byteLength;
      void tx.objectStore("parts").put({ id, part, data: IdbLocalStore.buf(data) });
    });
    // written last, in the same transaction: an object is "on this device" only when every part is
    void tx.objectStore("objects").put({ id, parts: parts.length, bytes, cachedAt: Date.now() });
    await tx.done;
  }

  async getSidecar(id: string): Promise<Bytes | undefined> {
    const rec = await (await this.db).get("sidecars", id);
    return rec ? (new Uint8Array(rec.data) as Bytes) : undefined;
  }

  async putSidecar(id: string, data: Bytes): Promise<void> {
    await (await this.db).put("sidecars", { id, data: IdbLocalStore.buf(data) });
  }

  async deleteObject(id: string): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(["parts", "objects", "sidecars"], "readwrite");
    const meta = await tx.objectStore("objects").get(id);
    for (let i = 0; i < (meta?.parts ?? 64); i++) void tx.objectStore("parts").delete([id, i]);
    void tx.objectStore("objects").delete(id);
    void tx.objectStore("sidecars").delete(id);
    await tx.done;
  }

  async objectIds(): Promise<Set<string>> {
    return new Set(await (await this.db).getAllKeys("objects"));
  }

  async usage(): Promise<number> {
    return (await (await this.db).getAll("objects")).reduce((n, o) => n + o.bytes, 0);
  }

  async getBlob(key: string): Promise<Bytes | undefined> {
    const rec = await (await this.db).get("blobs", key);
    return rec ? (new Uint8Array(rec.data) as Bytes) : undefined;
  }

  async putBlob(key: string, data: Bytes): Promise<void> {
    await (await this.db).put("blobs", { key, data: IdbLocalStore.buf(data) });
  }

  async deleteBlob(key: string): Promise<void> {
    await (await this.db).delete("blobs", key);
  }

  /** Everything, gone. Used when this device is told to forget the vault. */
  async wipe(): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(["parts", "objects", "sidecars", "blobs"], "readwrite");
    for (const name of ["parts", "objects", "sidecars", "blobs"] as const) void tx.objectStore(name).clear();
    await tx.done;
  }
}
