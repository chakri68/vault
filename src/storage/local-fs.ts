import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  NotFoundError, PreconditionFailedError, type StorageProvider, type StoredItem, assertAllowedPath,
} from "./provider";

type Bytes = Uint8Array<ArrayBuffer>;

/**
 * A folder on the server's disk. For development and for self-hosting on a
 * machine with a real filesystem. Same layout as every other provider, so the
 * folder is itself a valid backup.
 *
 * Compare-and-swap is serialised per path inside this process. That's enough
 * for one Node server; it is not a multi-process lock.
 */
export class LocalFsStorageProvider implements StorageProvider {
  id = "local-fs";
  name = "Local folder (server)";
  capabilities = { conditionalWrite: true, versioning: false, delete: true, list: true };

  private root: string;
  private locks = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  async connect() {
    await mkdir(this.root, { recursive: true });
  }
  async isConnected() {
    return stat(this.root).then((s) => s.isDirectory(), () => false);
  }
  async disconnect() {}

  private file(path: string): string {
    assertAllowedPath(path);
    const full = resolve(this.root, path);
    // belt and braces: the allowlist already forbids traversal
    if (!full.startsWith(this.root + sep)) throw new Error("path not allowed");
    return full;
  }

  private version(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex").slice(0, 32);
  }

  private locked<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(path) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(path, next.catch(() => {}));
    return next;
  }

  private async read(path: string): Promise<Bytes | null> {
    try {
      const buf = await readFile(this.file(path));
      return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) as Bytes;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async get(path: string) {
    const data = await this.read(path);
    if (!data) throw new NotFoundError();
    return { data, version: this.version(data) };
  }

  put(path: string, data: Bytes, opts?: { ifMatch?: string; ifNoneMatch?: "*" }) {
    return this.locked(path, async () => {
      const current = await this.read(path);
      if (opts?.ifNoneMatch === "*" && current) throw new PreconditionFailedError();
      if (opts?.ifMatch !== undefined && (!current || this.version(current) !== opts.ifMatch)) {
        throw new PreconditionFailedError();
      }
      const target = this.file(path);
      await mkdir(dirname(target), { recursive: true });
      // write-then-rename, so a crash never leaves half an object behind
      const tmp = `${target}.${randomUUID()}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, target);
      return { version: this.version(data) };
    });
  }

  delete(path: string, opts?: { ifMatch?: string }) {
    return this.locked(path, async () => {
      const current = await this.read(path);
      if (!current) return;
      if (opts?.ifMatch !== undefined && this.version(current) !== opts.ifMatch) throw new PreconditionFailedError();
      await rm(this.file(path), { force: true });
    });
  }

  async list(prefix = ""): Promise<StoredItem[]> {
    const out: StoredItem[] = [];
    const walk = async (dir: string, rel: string) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(dir, entry.name), relPath);
        else if (relPath.startsWith(prefix) && !relPath.endsWith(".tmp")) {
          const s = await stat(join(dir, entry.name));
          out.push({ path: relPath, size: s.size, version: `${s.size}-${Math.round(s.mtimeMs)}`, modifiedAt: s.mtime.toISOString() });
        }
      }
    };
    await walk(this.root, "");
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }
}
