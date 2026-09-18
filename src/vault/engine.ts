import { DecryptError } from "@/crypto/aes";
import { type Bytes, fromUtf8, newId, utf8 } from "@/crypto/bytes";
import { sha256Hex } from "@/crypto/checksum";
import { ContainerFormatError, openHeader, openObject, parsePrefix, sealObject } from "@/crypto/container";
import { openIndex, sealIndex } from "@/crypto/index-file";
import { openSidecar, sealSidecar } from "@/crypto/sidecar";
import type { DocMeta, Hints, ObjectHeader } from "@/schemas/file";
import type { IndexEntry, VaultIndex, VaultProfile } from "@/schemas/index";
import { NotFoundError, PreconditionFailedError, isPreconditionFailed } from "@/storage/provider";
import {
  type MetaPatch, applyPatch, emptyIndex, entryFromHeader, entryFromSidecar, getSetting,
  isExpiredTemporary, setState, sidecarFromEntry,
} from "./index-model";
import { BLOB, type LocalStore } from "./local-store";
import { mergeEntry, mergeIndexes, pruneTombstones, sameIndex, stableStringify } from "./merge";
import type { VaultRemote } from "./remote";

const DAY = 86_400_000;
const MAX_CAS_ATTEMPTS = 5;

export class IndexUnreadableError extends Error {
  constructor() {
    super("index unreadable");
    this.name = "IndexUnreadableError";
  }
}

export class IntegrityError extends Error {
  constructor() {
    super("integrity check failed");
    this.name = "IntegrityError";
  }
}

/** Anything that means "try again later", as opposed to "this is broken". */
export class OfflineError extends Error {
  constructor() {
    super("offline");
    this.name = "OfflineError";
  }
}

export interface NewDocument {
  content: Bytes;
  extension: string;
  mimeType: string;
  meta: DocMeta;
  createdByProfileId?: string;
}

export interface SyncStatus {
  syncing: boolean;
  /** documents, edits and deletions not yet saved to the store */
  pending: number;
  problem?: "offline" | "signed-out" | "conflict" | "needs-repair" | "server";
}

export interface Orphan {
  id: string;
  name?: string;
  size: number;
  readable: boolean;
}

interface Dirty {
  index: boolean;
  uploads: string[];
  sidecars: string[];
  deletes: string[];
}

export interface EngineOptions {
  remote: VaultRemote;
  local: LocalStore;
  vmk: CryptoKey;
  isAdmin?: () => boolean;
  now?: () => Date;
  onChange?: (index: VaultIndex, status: SyncStatus) => void;
  /** override in tests to exercise multi-part objects without 4 MB fixtures */
  partSize?: number;
}

const emptyDirty = (): Dirty => ({ index: false, uploads: [], sidecars: [], deletes: [] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The vault, minus the UI and minus the transport. Holds the decrypted index in
 * memory and keeps three things true:
 *
 *  1. Objects before index, always (§9.4). A failure in between leaves an
 *     identifiable orphan, never an entry pointing at nothing.
 *  2. Every index write is a compare-and-swap, and a lost race is resolved by
 *     the CRDT merge, never by overwriting (§9.2).
 *  3. Local edits are applied first and pushed after. Offline is not a special
 *     mode: the working index is sealed to disk with a list of dirty ids, and
 *     reconnecting is just another merge (§17.5).
 */
export class VaultEngine {
  private remote: VaultRemote;
  private local: LocalStore;
  private vmk: CryptoKey;
  private now: () => Date;
  private isAdmin: () => boolean;
  private onChange?: EngineOptions["onChange"];
  private partSize?: number;

  index: VaultIndex = emptyIndex();
  private remoteVersion: string | undefined;
  private dirty: Dirty = emptyDirty();
  private status: SyncStatus = { syncing: false, pending: 0 };
  private syncAgain = false;
  private syncChain: Promise<boolean> = Promise.resolve(true);
  private closed = false;
  /** bumped on every local change, so an in-flight push can tell its snapshot went stale */
  private revision = 0;

  constructor(opts: EngineOptions) {
    this.remote = opts.remote;
    this.local = opts.local;
    this.vmk = opts.vmk;
    this.now = opts.now ?? (() => new Date());
    this.isAdmin = opts.isAdmin ?? (() => true);
    this.onChange = opts.onChange;
    this.partSize = opts.partSize;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /**
   * Loads whatever this device already knows (works offline), then tries the
   * remote. Throws IndexUnreadableError when the only index available can't be
   * opened — the caller runs rebuild().
   */
  async open(): Promise<void> {
    const dirtyBlob = await this.local.getBlob(BLOB.dirty);
    if (dirtyBlob) {
      try {
        this.dirty = { ...emptyDirty(), ...(JSON.parse(fromUtf8(dirtyBlob)) as Partial<Dirty>) };
      } catch {
        this.dirty = emptyDirty();
      }
    }
    const version = await this.local.getBlob(BLOB.remoteIndexVersion);
    this.remoteVersion = version ? fromUtf8(version) : undefined;

    let loaded = false;
    for (const key of [BLOB.pendingIndex, BLOB.remoteIndex]) {
      const sealed = await this.local.getBlob(key);
      if (!sealed) continue;
      try {
        this.index = loaded ? mergeIndexes(this.index, await openIndex(this.vmk, sealed)) : await openIndex(this.vmk, sealed);
        loaded = true;
      } catch {
        // a cached copy that won't open is just a cache miss
      }
    }
    this.emit();

    try {
      await this.refresh();
    } catch (e) {
      if (e instanceof IndexUnreadableError) {
        this.setProblem("needs-repair");
        if (!loaded) throw e;
        return;
      }
      if (!loaded && !(e instanceof OfflineError)) throw e;
    }
    if (this.hasPending()) void this.sync();
  }

  close(): void {
    this.closed = true;
    this.index = emptyIndex();
    this.onChange = undefined;
  }

  getStatus(): SyncStatus {
    return { ...this.status, pending: this.pendingCount() };
  }

  // ───────────────────────────── reading ─────────────────────────────

  /** Pulls the remote index and joins it with local state. */
  async refresh(): Promise<void> {
    let fetched: { data: Bytes; version: string } | null;
    try {
      fetched = await this.remote.getIndex();
    } catch (e) {
      throw this.classify(e);
    }
    if (!fetched) {
      // No index on a vault that has objects means it was lost, not that the vault is empty.
      const objects = await this.remote.listObjects().catch(() => []);
      if (objects.length > 0 && Object.keys(this.index.entries).length === 0) throw new IndexUnreadableError();
      this.remoteVersion = undefined;
      this.dirty.index = true;
      return;
    }
    if (fetched.version === this.remoteVersion && Object.keys(this.index.entries).length > 0) return;

    let remoteIndex: VaultIndex;
    try {
      remoteIndex = await openIndex(this.vmk, fetched.data);
    } catch {
      throw new IndexUnreadableError();
    }
    const merged = this.hasPending() ? mergeIndexes(remoteIndex, this.index) : remoteIndex;
    if (this.hasPending() && !sameIndex(merged, remoteIndex)) this.dirty.index = true;
    this.index = merged;
    this.remoteVersion = fetched.version;
    await this.local.putBlob(BLOB.remoteIndex, fetched.data);
    await this.local.putBlob(BLOB.remoteIndexVersion, utf8(fetched.version));
    this.clearProblem();
    this.emit();
  }

  async isOnDevice(id: string): Promise<boolean> {
    return (await this.local.objectIds()).has(id);
  }

  /**
   * Ciphertext from the device if it's here, else from the store. Decrypts,
   * strips padding, and checks the plaintext against the checksum sealed in the
   * header (§25, §29). `keep` writes fetched ciphertext to the offline cache.
   */
  async fetchDocument(id: string, opts: { keep?: boolean } = {}): Promise<{ header: ObjectHeader; content: Bytes }> {
    let parts = await this.local.getObject(id);
    const fromCache = !!parts;
    if (!parts) {
      try {
        const first = await this.remote.getPart(id, 0);
        const { partCount } = parsePrefix(first);
        const rest = await Promise.all(
          Array.from({ length: partCount - 1 }, (_, i) => this.remote.getPart(id, i + 1)),
        );
        parts = [first, ...rest];
      } catch (e) {
        throw this.classify(e);
      }
    }
    let opened: { header: ObjectHeader; content: Bytes };
    try {
      opened = await openObject(this.vmk, parts);
      if ((await sha256Hex(opened.content)) !== opened.header.checksum) throw new IntegrityError();
    } catch (e) {
      if (fromCache) {
        // a damaged cached copy shouldn't shadow a good one in the store
        await this.local.deleteObject(id);
        return this.fetchDocument(id, opts);
      }
      if (e instanceof DecryptError || e instanceof ContainerFormatError) throw new IntegrityError();
      throw e;
    }
    if (!fromCache && opts.keep !== false) await this.local.putObject(id, parts);
    return opened;
  }

  /** Looks for an active document with the same plaintext checksum (§12.3). Local only. */
  findDuplicate(checksum: string): IndexEntry | undefined {
    return Object.values(this.index.entries).find((e) => e.checksum === checksum && e.state === "active");
  }

  // ───────────────────────────── writing ─────────────────────────────

  /**
   * Encrypts and stages a batch. Returns once the ciphertext is safely on this
   * device and in the working index; the push to the store follows (and is
   * awaited when online, so callers can report "saved" honestly).
   */
  async addDocuments(
    docs: NewDocument[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ids: string[]; synced: boolean }> {
    const nowIso = this.now().toISOString();
    const ids: string[] = [];
    const entries: IndexEntry[] = [];
    let done = 0;

    for (const doc of docs) {
      const id = newId();
      const header: ObjectHeader = {
        version: 1,
        id,
        extension: doc.extension,
        mimeType: doc.mimeType,
        plaintextSize: doc.content.length,
        checksum: await sha256Hex(doc.content),
        createdByProfileId: doc.createdByProfileId,
        createdAt: nowIso,
        updatedAt: nowIso,
        ...doc.meta,
        hints: this.hintsFor(doc.meta),
      };
      const sealed = await sealObject(this.vmk, header, doc.content, this.partSize);
      const entry = entryFromHeader(header, { encryptedSize: sealed.encryptedSize, partCount: sealed.parts.length });
      const sidecar = await sealSidecar(sealed.fileKey, sealed.wrappedKey, {
        ...sidecarFromEntry(entry), hints: header.hints,
      });
      await this.local.putObject(id, sealed.parts);
      await this.local.putSidecar(id, sidecar);
      ids.push(id);
      entries.push(entry);
      onProgress?.(++done, docs.length);
    }

    // one index change for the whole batch: either the set appears or none of it does (§9.5)
    const next = structuredClone(this.index);
    for (const e of entries) next.entries[e.id] = e;
    this.dirty.uploads.push(...ids);
    await this.commitLocal(next);
    const synced = await this.sync();
    return { ids, synced };
  }

  async updateMeta(id: string, patch: MetaPatch): Promise<void> {
    const entry = this.requireEntry(id);
    const next = structuredClone(this.index);
    next.entries[id] = applyPatch(entry, patch, this.now());
    if (!this.dirty.sidecars.includes(id)) this.dirty.sidecars.push(id);
    await this.commitLocal(next);
    void this.sync();
  }

  /** Reversible, and index-only: the object doesn't move (trash is a state, not a folder). */
  async trash(id: string): Promise<void> {
    await this.changeState(id, "trashed");
  }

  async restore(id: string): Promise<void> {
    await this.changeState(id, "active");
  }

  private async changeState(id: string, state: IndexEntry["state"]) {
    const next = structuredClone(this.index);
    next.entries[id] = setState(this.requireEntry(id), state, this.now());
    await this.commitLocal(next);
    void this.sync();
  }

  /**
   * Index first, then the files. If the second half fails, what's left is an
   * unreferenced object with a tombstone, which reconcile() clears.
   */
  async deletePermanently(id: string): Promise<void> {
    this.requireEntry(id);
    const now = this.now();
    const next = structuredClone(this.index);
    delete next.entries[id];
    next.tombstones[id] = {
      deletedAt: now.toISOString(),
      purgeAfter: now.toISOString(),
      shredded: false,
    };
    this.dirty.uploads = this.dirty.uploads.filter((x) => x !== id);
    this.dirty.sidecars = this.dirty.sidecars.filter((x) => x !== id);
    this.dirty.deletes.push(id);
    await this.local.deleteObject(id);
    await this.commitLocal(next);
    void this.sync();
  }

  async saveProfile(profile: Omit<VaultProfile, "createdAt" | "updatedAt"> & { createdAt?: string }): Promise<void> {
    const iso = this.now().toISOString();
    const existing = this.index.profiles.find((p) => p.id === profile.id);
    const next = structuredClone(this.index);
    next.profiles = next.profiles.filter((p) => p.id !== profile.id);
    next.profiles.push({ ...existing, ...profile, createdAt: existing?.createdAt ?? iso, updatedAt: iso });
    await this.commitLocal(next);
    void this.sync();
  }

  async removeProfile(id: string): Promise<void> {
    const iso = this.now().toISOString();
    const next = structuredClone(this.index);
    next.profiles = next.profiles.map((p) => (p.id === id ? { ...p, deletedAt: iso, updatedAt: iso } : p));
    await this.commitLocal(next);
    void this.sync();
  }

  async saveCategory(id: string, name: string): Promise<void> {
    const iso = this.now().toISOString();
    const next = structuredClone(this.index);
    const existing = next.categories.find((c) => c.id === id);
    next.categories = next.categories.filter((c) => c.id !== id);
    next.categories.push({ id, name, createdAt: existing?.createdAt ?? iso, updatedAt: iso });
    await this.commitLocal(next);
    void this.sync();
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    const next = structuredClone(this.index);
    const prev = next.settings[key]?.v;
    next.settings[key] = { value, v: Math.max((prev ?? 0) + 1, this.now().getTime()) };
    await this.commitLocal(next);
    void this.sync();
  }

  // ───────────────────────────── housekeeping ─────────────────────────────

  /**
   * Client-driven lifecycle (§7.4, §23.2): expired temporary files go to trash,
   * and trash past its retention is purged. Purging needs DELETE, which the
   * server only grants admins, so member devices skip that half.
   */
  async runLifecycle(): Promise<{ expired: string[]; purged: string[] }> {
    const now = this.now().getTime();
    const expired: string[] = [];
    const purged: string[] = [];

    for (const e of Object.values(this.index.entries)) {
      if (e.state === "active" && isExpiredTemporary(e, now)) expired.push(e.id);
    }
    for (const id of expired) await this.trash(id);

    const retention = getSetting<number | null>(this.index, "trashRetentionDays", 30);
    if (retention !== null && this.isAdmin()) {
      for (const e of Object.values(this.index.entries)) {
        if (e.state === "trashed" && e.trashedAt && Date.parse(e.trashedAt) + retention * DAY <= now) purged.push(e.id);
      }
      for (const id of purged) await this.deletePermanently(id);
    }
    return { expired, purged };
  }

  /**
   * §7.8. Anything in the store the index doesn't mention. An orphan is what an
   * upload leaves behind when it dies between the object write and the index
   * write; its own header says what it is, so it can be offered back by name.
   */
  async findOrphans(): Promise<Orphan[]> {
    const stored = await this.remote.listObjects().catch((e) => { throw this.classify(e); });
    const orphans: Orphan[] = [];
    for (const o of stored) {
      if (this.index.entries[o.id] || this.dirty.uploads.includes(o.id)) continue;
      if (this.index.tombstones[o.id]) {
        // deleted on purpose, files left behind by an interrupted delete
        if (this.isAdmin() && this.remoteVersion) {
          await this.remote.deleteObject(o.id, this.remoteVersion).catch(() => {});
        }
        continue;
      }
      const entry = await this.readEntryFromStore(o.id, o.hasSidecar).catch(() => null);
      orphans.push({ id: o.id, name: entry?.name, size: o.size, readable: !!entry });
    }
    return orphans;
  }

  async recoverOrphans(ids: string[]): Promise<void> {
    const next = structuredClone(this.index);
    for (const id of ids) {
      const entry = await this.readEntryFromStore(id, true);
      if (entry) next.entries[id] = entry;
    }
    await this.commitLocal(next);
    await this.sync();
  }

  async discardOrphans(ids: string[]): Promise<void> {
    if (!this.remoteVersion) throw new PreconditionFailedError();
    for (const id of ids) await this.remote.deleteObject(id, this.remoteVersion);
  }

  /**
   * §8.4. Rebuilds the index from the labels on the files. Reads the sidecar (a
   * couple of KB) where there is one, and falls back to the header sealed inside
   * the object. Loses only trash state — and not even that if the old index is
   * still readable, because the result is merged over it.
   */
  async rebuild(onProgress?: (done: number, total: number) => void): Promise<{ recovered: number; unreadable: number }> {
    const stored = await this.remote.listObjects().catch((e) => { throw this.classify(e); });
    const rebuilt = emptyIndex(this.now());
    const people = new Map<string, NonNullable<Hints["people"]>[number]>();
    const categoryNames = new Map<string, string>();
    let unreadable = 0;
    let done = 0;

    for (const o of stored) {
      try {
        const found = await this.readEntryFromStore(o.id, o.hasSidecar, (hints, entry) => {
          for (const p of hints.people ?? []) people.set(p.id, p);
          if (hints.categoryName && entry.category) categoryNames.set(entry.category, hints.categoryName);
        });
        if (found) rebuilt.entries[o.id] = found;
        else unreadable++;
      } catch (e) {
        if (e instanceof OfflineError) throw e;
        unreadable++;
      }
      onProgress?.(++done, stored.length);
    }

    const iso = this.now().toISOString();
    const known = new Set(rebuilt.categories.map((c) => c.id));
    for (const e of Object.values(rebuilt.entries)) {
      if (e.category && !known.has(e.category)) {
        known.add(e.category);
        rebuilt.categories.push({ id: e.category, name: categoryNames.get(e.category) ?? e.category, createdAt: iso, updatedAt: iso });
      }
      for (const pid of e.ownerProfileIds) {
        if (rebuilt.profiles.some((p) => p.id === pid)) continue;
        const hint = people.get(pid);
        rebuilt.profiles.push({
          id: pid, displayName: hint?.displayName ?? "Family member", tint: hint?.tint, avatar: hint?.avatar,
          // epoch-dated so any surviving real profile record outranks the reconstruction
          createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        });
      }
    }

    const next = mergeIndexes(this.index, rebuilt);
    this.dirty.index = true;
    await this.commitLocal(next);
    this.clearProblem();
    await this.sync({ replaceUnreadableRemote: true });
    return { recovered: Object.keys(rebuilt.entries).length, unreadable };
  }

  /** Downloads ciphertext for everything not yet on this device ("Keep everything offline"). */
  async cacheAll(onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean): Promise<void> {
    const have = await this.local.objectIds();
    const wanted = Object.values(this.index.entries).filter((e) => !have.has(e.id));
    let done = 0;
    for (const e of wanted) {
      if (this.closed || shouldStop?.()) return;
      await this.fetchDocument(e.id, { keep: true }).catch(() => {});
      onProgress?.(++done, wanted.length);
    }
  }

  async evict(id: string): Promise<void> {
    if (this.dirty.uploads.includes(id)) return; // the only copy: not evictable
    await this.local.deleteObject(id);
  }

  // ───────────────────────────── sync ─────────────────────────────

  /**
   * Pushes everything pending. Resolves true when the store is fully up to date.
   * Calls queue behind a run that's already in flight, so "did my change get
   * saved?" always has a real answer; a queued run with nothing to do is free.
   */
  sync(opts: { replaceUnreadableRemote?: boolean } = {}): Promise<boolean> {
    const run = () => this.syncOnce(opts);
    const next = this.syncChain.then(run, run);
    this.syncChain = next.catch(() => false);
    return next;
  }

  private async syncOnce(opts: { replaceUnreadableRemote?: boolean }): Promise<boolean> {
    if (this.closed) return false;
    if (!this.hasPending()) return true;
    this.status.syncing = true;
    this.emit();
    try {
      // 1. content, before anything references it
      for (const id of [...this.dirty.uploads]) {
        const entry = this.index.entries[id];
        const parts = await this.local.getObject(id);
        if (entry && parts) {
          for (let i = 0; i < parts.length; i++) await this.remote.putPart(id, i, parts[i]);
          if (!this.dirty.sidecars.includes(id)) this.dirty.sidecars.push(id);
        }
        this.dirty.uploads = this.dirty.uploads.filter((x) => x !== id);
        this.dirty.index = true;
        await this.persistDirty();
      }
      // (uploads are safe to clear after the push: content is immutable, so nothing can race it)
      // 2. the index, compare-and-swap
      if (this.dirty.index) await this.pushIndex(opts.replaceUnreadableRemote ?? false);
      // 3. labels. After the index, so they're written from the merged entry.
      for (const id of [...this.dirty.sidecars]) {
        // Cleared before the push, not after: an edit that lands mid-push re-adds
        // the id, and clearing afterwards would throw that away.
        this.dirty.sidecars = this.dirty.sidecars.filter((x) => x !== id);
        try {
          await this.pushSidecar(id);
        } catch (e) {
          if (!this.dirty.sidecars.includes(id)) this.dirty.sidecars.push(id);
          throw e;
        }
        await this.persistDirty();
      }
      if (this.dirty.index) await this.pushIndex(false); // a sidecar merge pulled in someone else's edit
      // 4. deletions, which the server checks against the index version we just wrote
      for (const id of [...this.dirty.deletes]) {
        if (!this.isAdmin()) break;
        if (this.remoteVersion) await this.remote.deleteObject(id, this.remoteVersion);
        this.dirty.deletes = this.dirty.deletes.filter((x) => x !== id);
        await this.persistDirty();
      }
      this.clearProblem();
      if (!this.hasPending()) await this.local.deleteBlob(BLOB.pendingIndex);
      return !this.hasPending();
    } catch (e) {
      const err = this.classify(e);
      this.setProblem(
        err instanceof OfflineError ? "offline"
        : err instanceof IndexUnreadableError ? "needs-repair"
        : isPreconditionFailed(err) ? "conflict"
        : (err as { status?: number }).status === 401 ? "signed-out"
        : "server",
      );
      return false;
    } finally {
      this.status.syncing = false;
      await this.persistDirty().catch(() => {});
      this.emit();
      if (this.syncAgain && !this.closed) {
        this.syncAgain = false;
        void this.sync();
      }
    }
  }

  private async pushIndex(replaceUnreadable: boolean): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      // A snapshot. Edits keep landing on this.index while we're awaiting the
      // network, so the snapshot is never written back over it.
      const revision = this.revision;
      const toWrite = pruneTombstones({ ...this.index, updatedAt: this.now().toISOString() }, this.now().getTime());
      const sealed = await sealIndex(this.vmk, toWrite);
      try {
        const { version } = await this.remote.putIndex(sealed, { ifMatch: this.remoteVersion });
        this.remoteVersion = version;
        if (this.revision === revision) this.dirty.index = false;
        else this.syncAgain = true;
        await this.local.putBlob(BLOB.remoteIndex, sealed);
        await this.local.putBlob(BLOB.remoteIndexVersion, utf8(version));
        return;
      } catch (e) {
        if (!isPreconditionFailed(e)) throw e;
      }
      // Someone else wrote first. Never overwrite them: fetch, join, go again.
      const theirs = await this.remote.getIndex();
      if (!theirs) {
        this.remoteVersion = undefined;
      } else {
        try {
          const theirIndex = await openIndex(this.vmk, theirs.data);
          this.index = mergeIndexes(theirIndex, this.index);
          this.revision++;
        } catch {
          if (!replaceUnreadable) throw new IndexUnreadableError();
        }
        this.remoteVersion = theirs.version;
      }
      await sleep(Math.random() * 120 * (attempt + 1));
    }
    throw new PreconditionFailedError();
  }

  private async pushSidecar(id: string): Promise<void> {
    if (!this.index.entries[id]) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const theirs = await this.remote.getSidecar(id);
      const source = theirs?.data ?? (await this.local.getSidecar(id));
      let keys: { fileKey: CryptoKey; wrappedKey: { nonce: Bytes; ciphertext: Bytes } } | undefined;
      let theirEntry: IndexEntry | undefined;

      if (source) {
        try {
          const opened = await openSidecar(this.vmk, source);
          keys = opened;
          if (theirs) theirEntry = entryFromSidecar(opened.sidecar);
        } catch {
          // unreadable: fall through and take the key from the object
        }
      }
      if (!keys) {
        // no usable sidecar anywhere: take the key from the object itself
        const parts = await this.local.getObject(id);
        const part0 = parts?.[0] ?? (await this.remote.getPart(id, 0));
        const opened = await openHeader(this.vmk, part0);
        keys = { fileKey: opened.fileKey, wrappedKey: opened.prefix.wrappedKey };
      }

      // Read the live entry only now, after the awaits, and fold in whatever
      // another device wrote to the label since we last looked. No await between
      // the read and the write-back, so a local edit can't slip through the gap.
      let current = this.index.entries[id];
      if (!current) return;
      if (theirEntry) {
        const merged = mergeEntry(current, {
          ...theirEntry, state: current.state, trashedAt: current.trashedAt,
          fieldVersions: { ...theirEntry.fieldVersions, state: current.fieldVersions.state ?? 0 },
        });
        if (stableStringify(merged) !== stableStringify(current)) {
          current = merged;
          this.index = { ...this.index, entries: { ...this.index.entries, [id]: merged } };
          this.revision++;
          this.dirty.index = true;
        }
      }

      const sealed = await sealSidecar(keys.fileKey, keys.wrappedKey, {
        ...sidecarFromEntry(current), hints: this.hintsFor(current),
      });
      try {
        await this.remote.putSidecar(id, sealed, { ifMatch: theirs?.version });
        await this.local.putSidecar(id, sealed);
        return;
      } catch (e) {
        if (!isPreconditionFailed(e)) throw e;
      }
    }
    throw new PreconditionFailedError();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async readEntryFromStore(
    id: string,
    hasSidecar: boolean,
    onHints?: (hints: Hints, entry: IndexEntry) => void,
  ): Promise<IndexEntry | null> {
    if (hasSidecar) {
      const sc = await this.remote.getSidecar(id).catch((e) => { throw this.classify(e); });
      if (sc) {
        try {
          const { sidecar } = await openSidecar(this.vmk, sc.data);
          const entry = entryFromSidecar(sidecar);
          if (sidecar.hints) onHints?.(sidecar.hints, entry);
          return entry;
        } catch {
          // fall through to the header
        }
      }
    }
    try {
      const part0 = await this.remote.getPart(id, 0);
      const { header, prefix } = await openHeader(this.vmk, part0);
      const stored = (await this.remote.listObjects()).find((o) => o.id === id);
      const entry = entryFromHeader(header, { encryptedSize: stored?.size ?? part0.length, partCount: prefix.partCount });
      if (header.hints) onHints?.(header.hints, entry);
      return entry;
    } catch (e) {
      const err = this.classify(e);
      if (err instanceof OfflineError) throw err;
      return null;
    }
  }

  private hintsFor(meta: Pick<DocMeta, "ownerProfileIds" | "category">): Hints | undefined {
    const people = meta.ownerProfileIds
      .map((pid) => this.index.profiles.find((p) => p.id === pid))
      .filter((p): p is VaultProfile => !!p)
      .map((p) => ({ id: p.id, displayName: p.displayName, tint: p.tint, avatar: p.avatar }));
    const categoryName = this.index.categories.find((c) => c.id === meta.category)?.name;
    if (people.length === 0 && !categoryName) return undefined;
    return { people: people.length ? people : undefined, categoryName };
  }

  private requireEntry(id: string): IndexEntry {
    const entry = this.index.entries[id];
    if (!entry) throw new NotFoundError(id);
    return entry;
  }

  /** Applies a change locally and makes it durable on this device before anything goes over the network. */
  private async commitLocal(next: VaultIndex): Promise<void> {
    this.index = { ...next, updatedAt: this.now().toISOString() };
    this.revision++;
    this.dirty.index = true;
    await this.local.putBlob(BLOB.pendingIndex, await sealIndex(this.vmk, this.index));
    await this.persistDirty();
    this.emit();
  }

  private persistDirty(): Promise<void> {
    return this.local.putBlob(BLOB.dirty, utf8(JSON.stringify(this.dirty)));
  }

  private hasPending(): boolean {
    return this.pendingCount() > 0 || this.dirty.index;
  }

  private pendingCount(): number {
    return new Set([...this.dirty.uploads, ...this.dirty.sidecars, ...this.dirty.deletes]).size;
  }

  private classify(e: unknown): unknown {
    if (e instanceof TypeError) return new OfflineError(); // what fetch throws when there's no network
    return e;
  }

  private setProblem(problem: SyncStatus["problem"]) {
    this.status.problem = problem;
  }

  private clearProblem() {
    this.status.problem = undefined;
  }

  private emit() {
    this.onChange?.(this.index, this.getStatus());
  }
}
