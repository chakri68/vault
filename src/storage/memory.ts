import {
  NotFoundError, PreconditionFailedError, type StorageProvider, type StoredItem, assertAllowedPath,
} from "./provider";

type Bytes = Uint8Array<ArrayBuffer>;

/**
 * In-memory provider for tests. Also the reference for what the interface
 * means: versions change on every write, CAS is strict, reads return copies.
 */
export class MemoryStorageProvider implements StorageProvider {
  id = "memory";
  name = "Memory";
  capabilities = { conditionalWrite: true, versioning: false, delete: true, list: true };

  private files = new Map<string, { data: Bytes; version: string; modifiedAt: string }>();
  private counter = 0;
  /** test hook: throw from the next operation whose path matches */
  failNext: { op: "put" | "get" | "delete"; match: RegExp; error: Error } | null = null;

  async connect() {}
  async isConnected() { return true; }
  async disconnect() {}

  private maybeFail(op: "put" | "get" | "delete", path: string) {
    const f = this.failNext;
    if (f && f.op === op && f.match.test(path)) {
      this.failNext = null;
      throw f.error;
    }
  }

  async get(path: string) {
    assertAllowedPath(path);
    this.maybeFail("get", path);
    const f = this.files.get(path);
    if (!f) throw new NotFoundError(path);
    return { data: f.data.slice() as Bytes, version: f.version };
  }

  async put(path: string, data: Bytes, opts?: { ifMatch?: string; ifNoneMatch?: "*" }) {
    assertAllowedPath(path);
    this.maybeFail("put", path);
    const current = this.files.get(path);
    if (opts?.ifNoneMatch === "*" && current) throw new PreconditionFailedError();
    if (opts?.ifMatch !== undefined && current?.version !== opts.ifMatch) throw new PreconditionFailedError();
    const version = `v${++this.counter}`;
    this.files.set(path, { data: data.slice() as Bytes, version, modifiedAt: new Date().toISOString() });
    return { version };
  }

  async delete(path: string, opts?: { ifMatch?: string }) {
    assertAllowedPath(path);
    this.maybeFail("delete", path);
    const current = this.files.get(path);
    if (!current) return;
    if (opts?.ifMatch !== undefined && current.version !== opts.ifMatch) throw new PreconditionFailedError();
    this.files.delete(path);
  }

  async list(prefix = ""): Promise<StoredItem[]> {
    return [...this.files.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, f]) => ({ path, size: f.data.length, version: f.version, modifiedAt: f.modifiedAt }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** test helper: flip a byte in a stored file */
  corrupt(path: string, offset: number) {
    const f = this.files.get(path);
    if (!f) throw new NotFoundError(path);
    f.data[offset] ^= 0xff;
  }
}
