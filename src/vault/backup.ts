import { open, seal } from "@/crypto/aes";
import { type Bytes, asBytes, concat, utf8 } from "@/crypto/bytes";
import { sha256Hex } from "@/crypto/checksum";
import { decodeCbor, encodeCbor } from "@/crypto/codec";
import { openHeader, parsePrefix } from "@/crypto/container";
import { openIndex } from "@/crypto/index-file";
import type { VaultIndex } from "@/schemas/index";
import { type StorageProvider, parseObjectPath, isNotFound } from "@/storage/provider";
import { INDEX_PATH, VAULT_JSON_PATH, objectPath, sidecarPath } from "./index-model";
import type { VaultRemote } from "./remote";

/**
 * §27. A backup is a second provider receiving the same bytes in the same
 * layout. No separate format and no separate code path, which is what makes a
 * folder backup restorable into a fresh GitHub repo without translation (§28).
 *
 * Nothing here is ever plaintext: ciphertext in, ciphertext out. The one thing
 * that needs the vault key is the manifest — which is sealed — and verification.
 */
export const MANIFEST_PATH = "backup-manifest.vault";
const MANIFEST_MAGIC = utf8("FVBM");
const MANIFEST_CONTEXT = "fv:backup-manifest";

export interface BackupManifest {
  version: 1;
  createdAt: string;
  /** sha-256 of each stored file's ciphertext, by path */
  files: Record<string, string>;
}

export interface BackupResult {
  documents: number;
  copied: number;
  skipped: number;
  verified: boolean;
  problems: string[];
}

export type Progress = (done: number, total: number, phase: "copying" | "checking") => void;

export async function sealManifest(vmk: CryptoKey, manifest: BackupManifest): Promise<Bytes> {
  const sealed = await seal(vmk, encodeCbor(manifest), MANIFEST_CONTEXT);
  return concat(MANIFEST_MAGIC, sealed.nonce, sealed.ciphertext);
}

export async function openManifest(vmk: CryptoKey, data: Bytes): Promise<BackupManifest | null> {
  try {
    if (data.length < 32 || MANIFEST_MAGIC.some((b, i) => data[i] !== b)) return null;
    const plain = await open(vmk, data.subarray(4, 16) as Bytes, data.subarray(16) as Bytes, MANIFEST_CONTEXT);
    const m = decodeCbor(plain) as BackupManifest;
    return m?.version === 1 && typeof m.files === "object" ? m : null;
  } catch {
    return null; // someone else's manifest, or a damaged one: start over
  }
}

async function getOrNull(dest: StorageProvider, path: string): Promise<Bytes | null> {
  try {
    return (await dest.get(path)).data;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Incremental mirror, then verification. Content objects are immutable, so one
 * that's already at the destination with a checksum on record is skipped; the
 * index, the labels and vault.json are small and always rewritten.
 *
 * "HTTP 200 is not a backup" (§27.5): after copying, every file is read back
 * from the destination and hashed, and the index that was written is opened
 * and checked against what's actually there.
 */
export async function mirrorTo(
  dest: StorageProvider,
  source: { remote: VaultRemote; vaultJson: Bytes },
  vmk: CryptoKey,
  onProgress?: Progress,
): Promise<BackupResult> {
  const problems: string[] = [];
  const objects = await source.remote.listObjects();
  const previous = await getOrNull(dest, MANIFEST_PATH).then((d) => (d ? openManifest(vmk, d) : null));
  const existing = new Map((await dest.list()).map((f) => [f.path, f.size]));
  const files: Record<string, string> = {};

  const total = objects.reduce((n, o) => n + o.parts + (o.hasSidecar ? 1 : 0), 0) + 2;
  let done = 0, copied = 0, skipped = 0;
  const tick = () => onProgress?.(++done, total, "copying");

  const write = async (path: string, data: Bytes) => {
    await dest.put(path, data);
    files[path] = await sha256Hex(data);
    copied++;
  };

  for (const o of objects) {
    for (let part = 0; part < o.parts; part++) {
      const path = objectPath(o.id, part);
      const known = previous?.files[path];
      if (known && existing.has(path)) {
        files[path] = known;
        skipped++;
      } else {
        await write(path, await source.remote.getPart(o.id, part));
      }
      tick();
    }
    if (o.hasSidecar) {
      const sc = await source.remote.getSidecar(o.id);
      if (sc) await write(sidecarPath(o.id), sc.data);
      tick();
    }
  }

  const index = await source.remote.getIndex();
  if (index) await write(INDEX_PATH, index.data);
  else problems.push("the vault has no index to back up");
  tick();
  await write(VAULT_JSON_PATH, source.vaultJson);
  tick();

  // anything at the destination that's no longer in the vault goes, so the backup doesn't grow forever
  for (const path of existing.keys()) {
    if (parseObjectPath(path) && !(path in files)) await dest.delete(path).catch(() => {});
  }

  await dest.put(MANIFEST_PATH, await sealManifest(vmk, { version: 1, createdAt: new Date().toISOString(), files }));

  const check = await verifyBackup(dest, vmk, (d, t) => onProgress?.(d, t, "checking"));
  return {
    documents: check.documents, copied, skipped,
    verified: check.ok && problems.length === 0,
    problems: [...problems, ...check.problems],
  };
}

/** Reads the backup back and proves it: every checksum, the object count, and that the index opens and resolves. */
export async function verifyBackup(
  dest: StorageProvider,
  vmk: CryptoKey,
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: boolean; documents: number; problems: string[] }> {
  const problems: string[] = [];
  const manifestBytes = await getOrNull(dest, MANIFEST_PATH);
  const manifest = manifestBytes ? await openManifest(vmk, manifestBytes) : null;
  if (!manifest) return { ok: false, documents: 0, problems: ["the backup's record of what it holds is missing or unreadable"] };

  const paths = Object.keys(manifest.files);
  let done = 0;
  for (const path of paths) {
    const data = await getOrNull(dest, path);
    if (!data) problems.push("a file is missing from the backup");
    else if ((await sha256Hex(data)) !== manifest.files[path]) problems.push("a file in the backup doesn't match what was written");
    onProgress?.(++done, paths.length);
  }

  let documents = 0;
  const indexBytes = await getOrNull(dest, INDEX_PATH);
  if (!indexBytes) problems.push("the backup has no index");
  else {
    try {
      const index = await openIndex(vmk, indexBytes);
      documents = Object.keys(index.entries).length;
      for (const e of Object.values(index.entries)) {
        for (let part = 0; part < e.partCount; part++) {
          if (!(objectPath(e.id, part) in manifest.files)) problems.push("a document listed in the vault isn't in the backup");
        }
      }
    } catch {
      problems.push("the backup's index can't be opened with this vault's key");
    }
  }
  return { ok: problems.length === 0, documents, problems: [...new Set(problems)] };
}

// ───────────────────────── restore (§28) ─────────────────────────

/** Anything that can hand back the files of a backup: a folder, or an unzipped backup file. */
export interface BackupReader {
  get(path: string): Promise<Bytes | null>;
  list(): Promise<string[]>;
}

export function readerFromProvider(p: StorageProvider): BackupReader {
  return { get: (path) => getOrNull(p, path), list: async () => (await p.list()).map((f) => f.path) };
}

export function readerFromFiles(files: Record<string, Uint8Array>): BackupReader {
  return { get: async (path) => (files[path] ? asBytes(files[path]) : null), list: async () => Object.keys(files) };
}

export interface RestorePlan {
  index: VaultIndex | null;
  objects: Array<{ id: string; parts: number; hasSidecar: boolean }>;
  problems: string[];
}

/** Checks a backup against itself before anything is written anywhere: references resolve, labels open. */
export async function planRestore(reader: BackupReader, vmk: CryptoKey): Promise<RestorePlan> {
  const problems: string[] = [];
  const paths = await reader.list();
  const byId = new Map<string, { id: string; parts: number; hasSidecar: boolean }>();
  for (const path of paths) {
    const parsed = parseObjectPath(path);
    if (!parsed) continue;
    const o = byId.get(parsed.id) ?? { id: parsed.id, parts: 0, hasSidecar: false };
    if (parsed.kind === "meta") o.hasSidecar = true; else o.parts++;
    byId.set(parsed.id, o);
  }

  let index: VaultIndex | null = null;
  const indexBytes = await reader.get(INDEX_PATH);
  if (indexBytes) {
    try {
      index = await openIndex(vmk, indexBytes);
    } catch {
      problems.push("The backup's index couldn't be opened. It will be rebuilt from the documents.");
    }
  } else problems.push("The backup has no index. It will be rebuilt from the documents.");

  for (const o of byId.values()) {
    const part0 = await reader.get(objectPath(o.id, 0));
    if (!part0) {
      problems.push("A document in the backup is incomplete and will be skipped.");
      byId.delete(o.id);
      continue;
    }
    try {
      const { partCount } = parsePrefix(part0);
      await openHeader(vmk, part0);
      if (partCount !== o.parts) throw new Error("parts");
    } catch {
      problems.push("A document in the backup is damaged and will be skipped.");
      byId.delete(o.id);
    }
  }
  if (index) {
    const missing = Object.keys(index.entries).filter((id) => !byId.has(id)).length;
    if (missing) problems.push(`${missing} listed ${missing === 1 ? "document is" : "documents are"} missing from the backup.`);
  }
  return { index, objects: [...byId.values()], problems: [...new Set(problems)] };
}
