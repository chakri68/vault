import { openDB } from "idb";

/**
 * Remembers which folder the family backs up to. A directory handle is a
 * capability, not a path: the browser still asks before each session's first
 * write, and it holds nothing about the vault.
 */
const db = () => openDB("family-vault-handles", 1, { upgrade: (d) => void d.createObjectStore("handles") });

type WithPermission = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: "readwrite" }) => Promise<PermissionState>;
};

export const folderBackupSupported = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

export async function savedBackupFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return ((await (await db()).get("handles", "backup")) as FileSystemDirectoryHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function pickBackupFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    const handle = await picker({ mode: "readwrite", id: "family-vault-backup" });
    await (await db()).put("handles", handle, "backup");
    return handle;
  } catch {
    return null; // cancelled
  }
}

/** Must run inside a tap: browsers only show the permission prompt on a user gesture. */
export async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as WithPermission;
  if (!h.queryPermission || !h.requestPermission) return true;
  if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return (await h.requestPermission({ mode: "readwrite" })) === "granted";
}

/** Asks nothing of the user: true only if the browser already lets us write there. For unattended backups. */
export async function alreadyWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as WithPermission;
  if (!h.queryPermission) return true;
  return (await h.queryPermission({ mode: "readwrite" }).catch(() => "denied")) === "granted";
}

export async function forgetBackupFolder(): Promise<void> {
  await (await db()).delete("handles", "backup").catch(() => {});
}
