import { NotFoundError, type StorageProvider, type StoredItem } from "./provider";

type Bytes = Uint8Array<ArrayBuffer>;

/**
 * A folder the family picked: an external SSD, a NAS mount, or an OS-synced
 * folder like iCloud Drive or Drive for desktop (which makes it a cloud backup
 * with no cloud API at all). File System Access API, entirely in the browser;
 * the server is not involved.
 *
 * Same layout as every other provider. Not eligible as a primary store: there's
 * no compare-and-swap on a directory.
 */
export class LocalFolderStorageProvider implements StorageProvider {
  id = "local-folder";
  name = "Folder on this computer";
  capabilities = { conditionalWrite: false, versioning: false, delete: true, list: true };

  constructor(private root: FileSystemDirectoryHandle) {}

  get label(): string {
    return this.root.name;
  }

  async connect() {}
  async isConnected() {
    try {
      // the permission API isn't in every TS lib yet
      const q = (this.root as unknown as { queryPermission?: (o: { mode: string }) => Promise<string> }).queryPermission;
      return !q || (await q.call(this.root, { mode: "readwrite" })) === "granted";
    } catch {
      return false;
    }
  }
  async disconnect() {}

  private async dir(segments: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = this.root;
    for (const s of segments) dir = await dir.getDirectoryHandle(s, { create });
    return dir;
  }

  private split(path: string): { segments: string[]; name: string } {
    const parts = path.split("/").filter(Boolean);
    if (parts.some((p) => p === "." || p === "..")) throw new Error("path not allowed");
    return { segments: parts.slice(0, -1), name: parts.at(-1)! };
  }

  async get(path: string): Promise<{ data: Bytes; version: string }> {
    const { segments, name } = this.split(path);
    try {
      const file = await (await (await this.dir(segments, false)).getFileHandle(name)).getFile();
      return { data: new Uint8Array(await file.arrayBuffer()) as Bytes, version: `${file.size}-${file.lastModified}` };
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") throw new NotFoundError();
      throw e;
    }
  }

  async put(path: string, data: Bytes): Promise<{ version: string }> {
    const { segments, name } = this.split(path);
    const handle = await (await this.dir(segments, true)).getFileHandle(name, { create: true });
    const writable = await handle.createWritable(); // writes to a temp file and swaps on close
    await writable.write(data);
    await writable.close();
    const file = await handle.getFile();
    return { version: `${file.size}-${file.lastModified}` };
  }

  async delete(path: string): Promise<void> {
    const { segments, name } = this.split(path);
    try {
      await (await this.dir(segments, false)).removeEntry(name);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
    }
  }

  async list(prefix = ""): Promise<StoredItem[]> {
    const out: StoredItem[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, rel: string) => {
      const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
      for await (const [name, handle] of entries) {
        const p = rel ? `${rel}/${name}` : name;
        if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, p);
        else if (p.startsWith(prefix)) {
          const file = await (handle as FileSystemFileHandle).getFile();
          out.push({ path: p, size: file.size, version: `${file.size}-${file.lastModified}`, modifiedAt: new Date(file.lastModified).toISOString() });
        }
      }
    };
    await walk(this.root, "");
    return out;
  }
}
