import { DecryptError, importAesKey } from "@/crypto/aes";
import { type Bytes, fromBase64, fromUtf8, newId, randomBytes, toBase64, toBase64Url, utf8 } from "@/crypto/bytes";
import { sha256Hex } from "@/crypto/checksum";
import {
  createPasswordEnvelope, createPrfEnvelope, createRecoveryEnvelope, derivePasswordKeys, derivePrfWrappingKey,
  deriveRecoveryKeys, deriveWriteAuthKey, generateVmk, newVaultJson, openLabel, sealLabel, unwrapVmk, vmkFingerprint,
} from "@/crypto/envelopes";
import { formatRecoveryCode, generateRecoveryCode, groupsOf, parseRecoveryCode } from "@/crypto/recovery-code";
import { Zip, ZipPassThrough, unzipSync } from "fflate";
import { istDateStamp } from "@/lib/format";
import { IdbLocalStore } from "@/offline/cache";
import { LocalFolderStorageProvider } from "@/storage/local-folder";
import {
  type BackupReader, type BackupResult, mirrorTo, planRestore, readerFromFiles, readerFromProvider,
} from "@/vault/backup";
import { INDEX_PATH, VAULT_JSON_PATH, objectPath, sidecarPath } from "@/vault/index-model";
import type { DocMeta, ObjectHeader } from "@/schemas/file";
import type { IndexEntry, VaultIndex, VaultProfile } from "@/schemas/index";
import { type VaultJson, VaultJsonSchema } from "@/schemas/vault";
import { IndexUnreadableError, type Orphan, type SyncStatus, VaultEngine } from "@/vault/engine";
import type { MetaPatch } from "@/vault/index-model";
import { BLOB } from "@/vault/local-store";
import { ApiClient, HttpError, type PublicConfig, type Role } from "./api";

export type UnlockVia = "password" | "passkey" | "recovery" | "setup";

export interface VaultState {
  phase: "loading" | "needs-setup" | "storage-problem" | "unreachable" | "locked" | "unlocked";
  config: PublicConfig | null;
  index: VaultIndex | null;
  sync: SyncStatus | null;
  role: Role | null;
  via: UnlockVia | null;
  /** unlocked without a server session (offline); saving needs one */
  needsSession: boolean;
  needsRepair: boolean;
  /** ids whose ciphertext is on this device */
  onDevice: string[];
  prefs: DevicePrefs;
  cacheBytes: number;
}

/** Per-device, not per-vault. Opaque ids and booleans only, so it's safe next to the ciphertext. */
export interface DevicePrefs {
  keepEverythingOffline: boolean;
  pins: string[];
  lockAfterMinutes: number | null;
  activeProfileId: string | null;
  /** ids opened on this device, most recent first */
  recent: string[];
  lastBackup?: { at: string; destination: string; documents: number; verified: boolean };
  /** the last backup file made on this device. Where it went after that, only the family knows. */
  lastExport?: { at: string; documents: number; verified: boolean };
  /** how often the chosen folder is refreshed without being asked (§27.4) */
  backupEvery: "change" | "daily" | "weekly" | "manual";
}

const DEFAULT_PREFS: DevicePrefs = {
  keepEverythingOffline: true, pins: [], lockAfterMinutes: 5, activeProfileId: null, recent: [], backupEvery: "change",
};

export type UnlockFailure =
  | "wrong"            // same answer for every kind of wrong (§40.6)
  | "rate-limited"
  | "offline-first-time" // never unlocked on this device, and no network
  | "invalid-code"
  | "key-changed"
  | "no-passkey-here"
  | "server";

export type UnlockResult = { ok: true } | { ok: false; reason: UnlockFailure; retryAfter?: number };

export interface NewDocumentInput {
  content: Bytes;
  extension: string;
  mimeType: string;
  meta: DocMeta;
}

export interface DeviceInfo {
  envelopeId: string;
  credentialId: string;
  label: string | undefined;
  role: Role | null;
  createdAt: string;
  current: boolean;
}

const PREFS_BLOB = "prefs.json";
const CONFIG_BLOB = "config.json";
const FINGERPRINT_BLOB = "vmk.fingerprint";

const isNetworkError = (e: unknown) => e instanceof TypeError;

/**
 * Everything that touches a key lives here, and "here" is a Web Worker: the
 * page's thread never holds the vault key, only asks for things to be done
 * with it.
 *
 * What that buys, honestly: script on the page can't read the key out of this
 * worker's memory. What it doesn't: that same script could still *ask* the
 * worker to decrypt. And JavaScript can't promise memory is zeroed — locking
 * drops every reference and overwrites what it can, which narrows the window,
 * not closes it (§5.4).
 */
export class VaultSession {
  private api = new ApiClient();
  private local = new IdbLocalStore();
  private engine: VaultEngine | null = null;
  private vmkRaw: Bytes | null = null;
  private vmk: CryptoKey | null = null;
  private vault: { json: VaultJson; version: string | null } | null = null;
  private pendingSetup: {
    vmk: Bytes; vaultJson: VaultJson; passwordAuthSecret: Bytes; recoveryAuthSecret: Bytes; recoveryCode: string;
  } | null = null;
  /** lets a password or recovery unlock re-establish an expired server session without asking again */
  private reauth: { kind: "password" | "recovery"; authSecret: string } | null = null;
  private currentCredentialId: string | null = null;
  /** a recovery code that's been shown but not yet typed back (setup, or Settings → Recovery code) */
  private pendingRecoveryCode: string | null = null;
  private pendingRestore: { reader: BackupReader; vault: VaultJson; vaultJsonBytes: Bytes } | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private cacheRun = 0;

  private state: VaultState = {
    phase: "loading", config: null, index: null, sync: null, role: null, via: null,
    needsSession: false, needsRepair: false, onDevice: [], prefs: DEFAULT_PREFS, cacheBytes: 0,
  };

  constructor(private emit: (state: VaultState) => void) {}

  private set(patch: Partial<VaultState>) {
    this.state = { ...this.state, ...patch };
    this.emit(this.state);
  }

  private requireEngine(): VaultEngine {
    if (!this.engine) throw new Error("locked");
    return this.engine;
  }

  // ───────────────────────────── start ─────────────────────────────

  async init(): Promise<void> {
    const prefs = await this.readJson<DevicePrefs>(PREFS_BLOB);
    this.set({ prefs: { ...DEFAULT_PREFS, ...prefs } });
    await this.loadConfig();
  }

  async loadConfig(): Promise<void> {
    try {
      const config = await this.api.config();
      if (config.initialized) await this.local.putBlob(CONFIG_BLOB, utf8(JSON.stringify(config)));
      if (this.state.phase === "unlocked") return void this.set({ config });
      this.set({
        config,
        phase: config.initialized === true ? "locked" : config.initialized === false ? "needs-setup" : "storage-problem",
      });
    } catch (e) {
      // No network, or the host is down. A device that has opened this vault before can still open it.
      const cached = await this.readJson<PublicConfig>(CONFIG_BLOB);
      if (this.state.phase === "unlocked") return;
      if (cached && (await this.local.getBlob(BLOB.vaultJson))) this.set({ config: cached, phase: "locked" });
      else this.set({ phase: isNetworkError(e) ? "unreachable" : "storage-problem" });
    }
  }

  // ───────────────────────────── setup (§36) ─────────────────────────────

  /**
   * Generates the vault key and both mandatory envelopes, in memory only.
   * Nothing is sent anywhere until the recovery code has been typed back.
   */
  async beginSetup(password: string): Promise<{ groups: string[]; formatted: string }> {
    const vmk = generateVmk();
    const vaultId = newId();
    const recoveryCode = await generateRecoveryCode();
    const pw = await createPasswordEnvelope(vmk, vaultId, password);
    const rc = await createRecoveryEnvelope(vmk, vaultId, recoveryCode);
    this.pendingRecoveryCode = recoveryCode;
    this.pendingSetup = {
      vmk, recoveryCode,
      vaultJson: newVaultJson([pw.envelope, rc.envelope], vaultId),
      passwordAuthSecret: pw.authSecret,
      recoveryAuthSecret: rc.authSecret,
    };
    return { groups: groupsOf(recoveryCode), formatted: formatRecoveryCode(recoveryCode) };
  }

  /** Did they really write it down? Checks the groups the UI asked for. */
  checkRecoveryGroups(answers: Array<{ group: number; value: string }>): boolean[] {
    const groups = groupsOf(this.pendingRecoveryCode ?? "");
    return answers.map((a) => a.value.toUpperCase().replace(/\s/g, "").replace(/O/g, "0").replace(/[IL]/g, "1") === groups[a.group]);
  }

  async completeSetup(setupToken?: string): Promise<void> {
    const p = this.pendingSetup;
    if (!p) throw new Error("no setup in progress");
    await this.api.setup({
      setupToken,
      vaultJson: p.vaultJson,
      passwordAuthSecret: toBase64(p.passwordAuthSecret),
      recoveryAuthSecret: toBase64(p.recoveryAuthSecret),
      writeAuthKey: toBase64(await deriveWriteAuthKey(p.vmk, p.vaultJson.vaultId)),
    });
    this.pendingSetup = null;
    this.pendingRecoveryCode = null;
    this.reauth = { kind: "password", authSecret: toBase64(p.passwordAuthSecret) };
    const fresh = await this.api.vaultJson();
    await this.local.putBlob(BLOB.vaultJson, fresh.data);
    this.vault = { json: fresh.vault, version: fresh.version };
    await this.finishUnlock(p.vmk, "setup");
    // they just typed the code back, so the six-month "can you still find it?" clock starts now (§20.4)
    await this.engine?.setSetting("recoveryCheckedAt", new Date().toISOString());
    await this.loadConfig();
  }

  /**
   * §36: setup isn't done until a real object has made the whole trip —
   * encrypt, upload, forget, download, decrypt, verify. Then it's removed, so
   * no mystery file turns up in the family's documents.
   */
  async selfTest(onStep?: (step: "encrypt" | "upload" | "download" | "verify" | "cleanup") => void): Promise<boolean> {
    const engine = this.requireEngine();
    const content = randomBytes(2048);
    onStep?.("encrypt");
    const { ids, synced } = await engine.addDocuments([{
      content, extension: "bin", mimeType: "application/octet-stream",
      meta: { name: "Setup check", ownerProfileIds: [], tags: [] },
    }]);
    onStep?.("upload");
    if (!synced && !(await engine.sync())) return false;
    await engine.evict(ids[0]); // make the read come from the store, not from this device
    onStep?.("download");
    const back = await engine.fetchDocument(ids[0], { keep: false });
    onStep?.("verify");
    const ok = (await sha256Hex(back.content)) === (await sha256Hex(content));
    onStep?.("cleanup");
    await engine.deletePermanently(ids[0]);
    await engine.sync();
    return ok;
  }

  // ───────────────────────────── unlock (§5) ─────────────────────────────

  /** vault.json from the server when there's a session, else this device's copy. */
  private async fetchVaultJson(online: boolean): Promise<VaultJson | null> {
    if (online) {
      const fresh = await this.api.vaultJson();
      await this.local.putBlob(BLOB.vaultJson, fresh.data);
      this.vault = { json: fresh.vault, version: fresh.version };
      return fresh.vault;
    }
    const cached = await this.local.getBlob(BLOB.vaultJson);
    if (!cached) return null;
    const json = VaultJsonSchema.parse(JSON.parse(fromUtf8(cached)));
    this.vault = { json, version: null };
    return json;
  }

  private failure(e: unknown): UnlockResult {
    if (e instanceof HttpError) {
      if (e.status === 401 || e.status === 400) return { ok: false, reason: "wrong" };
      if (e.status === 429) return { ok: false, reason: "rate-limited", retryAfter: e.retryAfter };
      return { ok: false, reason: "server" };
    }
    if (e instanceof DecryptError) return { ok: false, reason: "wrong" };
    if (e instanceof KeyChangedError) return { ok: false, reason: "key-changed" };
    return { ok: false, reason: "server" };
  }

  async unlockWithPassword(password: string): Promise<UnlockResult> {
    try {
      const kdf = this.state.config?.kdf;
      if (!kdf) return { ok: false, reason: "offline-first-time" };
      const keys = await derivePasswordKeys(password, fromBase64(kdf.salt), kdf.params);
      const authSecret = toBase64(keys.authSecret);

      let online = true;
      try {
        await this.api.authPassword(authSecret);
      } catch (e) {
        if (!isNetworkError(e)) return this.failure(e);
        online = false; // unlocking is local; only saving needs the server (§17.3)
      }
      const vault = await this.fetchVaultJson(online);
      if (!vault) return { ok: false, reason: "offline-first-time" };
      const envelope = vault.envelopes.find((x) => x.kind === "password");
      if (!envelope) return { ok: false, reason: "wrong" };
      const vmk = await unwrapVmk(envelope, keys.wrappingKey, vault.vaultId);
      keys.wrappingKey.fill(0);
      this.reauth = { kind: "password", authSecret };
      await this.finishUnlock(vmk, "password", !online);
      return { ok: true };
    } catch (e) {
      return this.failure(e);
    }
  }

  async unlockWithRecoveryCode(input: string): Promise<UnlockResult> {
    try {
      const parsed = await parseRecoveryCode(input);
      if (!parsed.ok) return { ok: false, reason: "invalid-code" };
      const salt = this.state.config?.recoverySalt;
      if (!salt) return { ok: false, reason: "offline-first-time" };
      const keys = await deriveRecoveryKeys(parsed.code, fromBase64(salt));
      const authSecret = toBase64(keys.authSecret);
      let online = true;
      try {
        await this.api.authRecovery(authSecret);
      } catch (e) {
        if (!isNetworkError(e)) return this.failure(e);
        online = false;
      }
      const vault = await this.fetchVaultJson(online);
      if (!vault) return { ok: false, reason: "offline-first-time" };
      const envelope = vault.envelopes.find((x) => x.kind === "recovery-code");
      if (!envelope) return { ok: false, reason: "wrong" };
      const vmk = await unwrapVmk(envelope, keys.wrappingKey, vault.vaultId);
      this.reauth = { kind: "recovery", authSecret };
      await this.finishUnlock(vmk, "recovery", !online);
      return { ok: true };
    } catch (e) {
      return this.failure(e);
    }
  }

  /**
   * Step one of a passkey unlock. Online, the challenge is the server's, and the
   * same touch yields a server session. Offline there's nobody to challenge us,
   * so the challenge is local and only the PRF output matters.
   */
  async passkeyOptions(): Promise<{ options: Record<string, unknown>; prfSalt: string; online: boolean } | null> {
    const config = this.state.config;
    if (!config?.prfSalt) return null;
    try {
      const options = (await this.api.webauthnBegin()) as Record<string, unknown>;
      return { options, prfSalt: config.prfSalt, online: true };
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      return {
        options: { challenge: toBase64Url(randomBytes(32)), rpId: config.rpId, userVerification: "required", allowCredentials: [], timeout: 60_000 },
        prfSalt: config.prfSalt,
        online: false,
      };
    }
  }

  async unlockWithPasskey(input: { response: { id: string }; prfOutput: Bytes; online: boolean }): Promise<UnlockResult> {
    try {
      if (input.online) await this.api.webauthnFinish(input.response);
      const vault = await this.fetchVaultJson(input.online);
      if (!vault) return { ok: false, reason: "offline-first-time" };
      const envelope = vault.envelopes.find((x) => x.kind === "passkey-prf" && x.credentialId === input.response.id);
      if (!envelope) return { ok: false, reason: "no-passkey-here" };
      const wrappingKey = await derivePrfWrappingKey(input.prfOutput, fromBase64(envelope.salt));
      const vmk = await unwrapVmk(envelope, wrappingKey, vault.vaultId);
      wrappingKey.fill(0);
      input.prfOutput.fill(0);
      this.reauth = null;
      this.currentCredentialId = input.response.id;
      await this.finishUnlock(vmk, "passkey", !input.online);
      return { ok: true };
    } catch (e) {
      return this.failure(e);
    }
  }

  /** B-19: opened offline with a fingerprint, now back online with changes to save. */
  async resumeSession(response: { id: string }): Promise<boolean> {
    try {
      await this.api.webauthnFinish(response);
      this.set({ needsSession: false, role: this.api.role });
      await this.engine?.sync();
      return true;
    } catch {
      return false;
    }
  }

  private async finishUnlock(vmkRaw: Bytes, via: UnlockVia, offline = false): Promise<void> {
    const vaultId = this.vault!.json.vaultId;

    // Trust on first use. If vault.json were swapped for one wrapping a different
    // key, everything new would be encrypted to the attacker. A device that has
    // seen the real key refuses to carry on with another.
    const fingerprint = await vmkFingerprint(vmkRaw, vaultId);
    const known = await this.local.getBlob(FINGERPRINT_BLOB);
    if (known && fromUtf8(known) !== `${vaultId}:${fingerprint}`) {
      const knownVault = fromUtf8(known).split(":")[0];
      if (knownVault === vaultId) throw new KeyChangedError();
      // A different vault entirely: this device's cache belongs to the old one.
      await this.local.wipe();
      await this.local.putBlob(BLOB.vaultJson, utf8(JSON.stringify(this.vault!.json)));
      if (this.state.config?.initialized) await this.local.putBlob(CONFIG_BLOB, utf8(JSON.stringify(this.state.config)));
    }
    await this.local.putBlob(FINGERPRINT_BLOB, utf8(`${vaultId}:${fingerprint}`));

    this.vmkRaw = vmkRaw;
    this.vmk = await importAesKey(vmkRaw);
    this.api.setWriteAuthKey(await deriveWriteAuthKey(vmkRaw, vaultId));

    this.engine = new VaultEngine({
      remote: this.api, local: this.local, vmk: this.vmk,
      isAdmin: () => this.api.role === "admin",
      onChange: (index, sync) => {
        // an index that turns out to be unreadable once the background refresh lands
        this.set(sync.problem === "needs-repair" ? { index, sync, needsRepair: true } : { index, sync });
        if (sync.problem === "signed-out") void this.recoverSession();
      },
    });

    let needsRepair = false;
    try {
      await this.engine.open();
    } catch (e) {
      if (!(e instanceof IndexUnreadableError)) throw e;
      needsRepair = true;
    }
    this.set({
      phase: "unlocked", via, role: this.api.role, needsSession: offline, needsRepair,
      index: this.engine.index, sync: this.engine.getStatus(),
    });
    await this.refreshCacheInfo();
    this.startBackgroundWork();
  }

  private async recoverSession(): Promise<void> {
    if (!this.reauth) return void this.set({ needsSession: true });
    try {
      if (this.reauth.kind === "password") await this.api.authPassword(this.reauth.authSecret);
      else await this.api.authRecovery(this.reauth.authSecret);
      this.set({ needsSession: false, role: this.api.role });
      await this.engine?.sync();
    } catch {
      // still offline, or the password changed elsewhere; the banner will say so
      this.set({ needsSession: true });
    }
  }

  private startBackgroundWork() {
    const engine = this.requireEngine();
    void engine.runLifecycle().catch(() => {});
    // push anything pending; pull what others changed
    this.timers.push(setInterval(() => void engine.sync(), 30_000));
    this.timers.push(setInterval(() => void engine.refresh().catch(() => {}), 120_000));
    self.addEventListener?.("online", this.onOnline);
    if (this.state.prefs.keepEverythingOffline) void this.cacheEverything();
  }

  private onOnline = () => {
    if (this.state.needsSession) void this.recoverSession();
    else void this.engine?.sync();
  };

  /** Drops every key and every decrypted thing. A fresh start is always locked (§18). */
  async lock(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.cacheRun++;
    self.removeEventListener?.("online", this.onOnline);
    this.engine?.close();
    this.engine = null;
    this.vmkRaw?.fill(0);
    this.vmkRaw = null;
    this.vmk = null;
    this.vault = null;
    this.reauth = null;
    this.pendingSetup = null;
    this.pendingRecoveryCode = null;
    this.pendingRestore = null;
    this.currentCredentialId = null;
    void this.api.logout();
    this.api.clear();
    this.set({ phase: "locked", index: null, sync: null, role: null, via: null, needsSession: false, needsRepair: false });
  }

  // ───────────────────────────── documents ─────────────────────────────

  /** Checksum of the plaintext, compared locally against the index. Never leaves the device (§12.3). */
  async findDuplicate(content: Bytes): Promise<IndexEntry | null> {
    return this.requireEngine().findDuplicate(await sha256Hex(content)) ?? null;
  }

  async addDocuments(
    docs: NewDocumentInput[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ids: string[]; synced: boolean }> {
    const result = await this.requireEngine().addDocuments(
      docs.map((d) => ({ ...d, createdByProfileId: this.state.prefs.activeProfileId ?? undefined })),
      onProgress,
    );
    await this.refreshCacheInfo();
    return result;
  }

  async openDocument(id: string): Promise<{ header: ObjectHeader; content: Bytes }> {
    const engine = this.requireEngine();
    const entry = engine.index.entries[id];
    const prefs = this.state.prefs;
    // Identity documents stay on the device from first open: they're the ones needed at a counter (§17.2).
    const keep = prefs.keepEverythingOffline || prefs.pins.includes(id) || entry?.category === "identity";
    const opened = await engine.fetchDocument(id, { keep });
    if (keep) await this.refreshCacheInfo();
    await this.setPrefs({ recent: [id, ...prefs.recent.filter((x) => x !== id)].slice(0, 12) });
    return opened;
  }

  updateMeta(id: string, patch: MetaPatch) { return this.requireEngine().updateMeta(id, patch); }
  trash(id: string) { return this.requireEngine().trash(id); }
  restore(id: string) { return this.requireEngine().restore(id); }
  async deletePermanently(id: string) {
    await this.requireEngine().deletePermanently(id);
    await this.refreshCacheInfo();
  }
  saveProfile(profile: Omit<VaultProfile, "createdAt" | "updatedAt">) { return this.requireEngine().saveProfile(profile); }
  removeProfile(id: string) { return this.requireEngine().removeProfile(id); }
  saveCategory(id: string, name: string) { return this.requireEngine().saveCategory(id, name); }
  setSetting(key: string, value: unknown) { return this.requireEngine().setSetting(key, value); }
  syncNow() { return this.requireEngine().sync(); }
  async refresh() { await this.requireEngine().refresh().catch(() => {}); }
  findOrphans(): Promise<Orphan[]> { return this.requireEngine().findOrphans(); }
  recoverOrphans(ids: string[]) { return this.requireEngine().recoverOrphans(ids); }
  discardOrphans(ids: string[]) { return this.requireEngine().discardOrphans(ids); }

  async rebuild(onProgress?: (done: number, total: number) => void) {
    const result = await this.requireEngine().rebuild(onProgress);
    this.set({ needsRepair: false });
    return result;
  }

  // ───────────────────────────── this device ─────────────────────────────

  async setPrefs(patch: Partial<DevicePrefs>): Promise<void> {
    const prefs = { ...this.state.prefs, ...patch };
    this.set({ prefs });
    await this.local.putBlob(PREFS_BLOB, utf8(JSON.stringify(prefs)));
    if (patch.keepEverythingOffline === true && this.engine) void this.cacheEverything();
    if (patch.keepEverythingOffline === false) this.cacheRun++;
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    const pins = new Set(this.state.prefs.pins);
    if (pinned) pins.add(id); else pins.delete(id);
    await this.setPrefs({ pins: [...pins] });
    if (pinned) await this.requireEngine().fetchDocument(id, { keep: true }).catch(() => {});
    else if (!this.state.prefs.keepEverythingOffline) await this.requireEngine().evict(id);
    await this.refreshCacheInfo();
  }

  private async cacheEverything(): Promise<void> {
    const run = ++this.cacheRun;
    await this.engine?.cacheAll(() => void this.refreshCacheInfo(), () => run !== this.cacheRun).catch(() => {});
    await this.refreshCacheInfo();
  }

  private async refreshCacheInfo(): Promise<void> {
    const [ids, bytes] = await Promise.all([this.local.objectIds(), this.local.usage()]);
    this.set({ onDevice: [...ids], cacheBytes: bytes });
  }

  /** Forget this vault on this device: the cache, the queue, everything. */
  async forgetDevice(): Promise<void> {
    await this.lock();
    await this.local.wipe();
    this.set({ onDevice: [], cacheBytes: 0, prefs: DEFAULT_PREFS });
  }

  // ───────────────────────────── credentials ─────────────────────────────

  enrolOptions(): Promise<unknown> {
    return this.api.enrolBegin();
  }

  /** Wraps the vault key under the new passkey's PRF output, and registers the passkey with the server. */
  async enrolPasskey(input: { response: { id: string }; prfOutput: Bytes; label: string }): Promise<Role> {
    if (!this.vmkRaw || !this.vmk || !this.vault) throw new Error("locked");
    const envelope = await createPrfEnvelope(this.vmkRaw, this.vault.json.vaultId, input.response.id, input.prfOutput);
    envelope.label = await sealLabel(this.vmk, envelope.id, input.label);
    input.prfOutput.fill(0);
    const { role } = await this.api.enrolFinish(input.response, envelope);
    this.currentCredentialId ??= input.response.id;
    await this.fetchVaultJson(true);
    await this.loadConfig();
    return role;
  }

  async devices(): Promise<DeviceInfo[]> {
    if (!this.vmk) throw new Error("locked");
    const vault = (await this.fetchVaultJson(true).catch(() => null)) ?? this.vault?.json;
    const registered = await this.api.credentials().catch(() => null);
    const out: DeviceInfo[] = [];
    for (const e of vault?.envelopes ?? []) {
      if (e.kind !== "passkey-prf" || !e.credentialId) continue;
      out.push({
        envelopeId: e.id,
        credentialId: e.credentialId,
        label: await openLabel(this.vmk, e).catch(() => undefined),
        role: registered?.credentials.find((c) => c.id === e.credentialId)?.role ?? null,
        createdAt: e.createdAt,
        current: e.credentialId === (registered?.current ?? this.currentCredentialId),
      });
    }
    return out;
  }

  async removeDevice(credentialId: string): Promise<void> {
    await this.api.removeCredential(credentialId);
    await this.fetchVaultJson(true);
    await this.loadConfig();
  }

  setDeviceRole(credentialId: string, role: Role) { return this.api.setCredentialRole(credentialId, role); }

  async changePassword(newPassword: string): Promise<void> {
    if (!this.vmkRaw) throw new Error("locked");
    const current = await this.api.vaultJson();
    const next = await createPasswordEnvelope(this.vmkRaw, current.vault.vaultId, newPassword);
    const vaultJson = { ...current.vault, envelopes: [...current.vault.envelopes.filter((e) => e.kind !== "password"), next.envelope] };
    await this.api.replaceEnvelope("password", vaultJson, toBase64(next.authSecret), current.version);
    if (this.reauth?.kind === "password") this.reauth.authSecret = toBase64(next.authSecret);
    await this.fetchVaultJson(true);
    await this.loadConfig();
  }

  /**
   * The old code can't be shown again — it was never stored, only what it
   * wraps. "View recovery code" therefore means "make a new one", and the old
   * one stops working the moment the new one is confirmed.
   */
  async beginNewRecoveryCode(): Promise<{ groups: string[]; formatted: string }> {
    if (!this.vmkRaw) throw new Error("locked");
    this.pendingRecoveryCode = await generateRecoveryCode();
    return { groups: groupsOf(this.pendingRecoveryCode), formatted: formatRecoveryCode(this.pendingRecoveryCode) };
  }

  async commitNewRecoveryCode(): Promise<void> {
    if (!this.vmkRaw || !this.pendingRecoveryCode) throw new Error("locked");
    const current = await this.api.vaultJson();
    const next = await createRecoveryEnvelope(this.vmkRaw, current.vault.vaultId, this.pendingRecoveryCode);
    const vaultJson = { ...current.vault, envelopes: [...current.vault.envelopes.filter((e) => e.kind !== "recovery-code"), next.envelope] };
    await this.api.replaceEnvelope("recovery-code", vaultJson, toBase64(next.authSecret), current.version);
    this.pendingRecoveryCode = null;
    await this.engine?.setSetting("recoveryCheckedAt", new Date().toISOString());
    if (this.reauth?.kind === "recovery") this.reauth.authSecret = toBase64(next.authSecret);
    await this.fetchVaultJson(true);
    await this.loadConfig();
  }

  // ───────────────────────────── backups (§27) ─────────────────────────────

  /** Mirrors the vault into a folder the family picked, then reads it back to prove it. */
  async backupToFolder(
    handle: FileSystemDirectoryHandle,
    onProgress?: (done: number, total: number, phase: "copying" | "checking") => void,
  ): Promise<BackupResult> {
    if (!this.vmk) throw new Error("locked");
    await this.requireEngine().sync();
    const dest = new LocalFolderStorageProvider(handle);
    const vaultJson = (await this.api.vaultJson()).data;
    const result = await mirrorTo(dest, { remote: this.api, vaultJson }, this.vmk, onProgress);
    await this.setPrefs({
      lastBackup: { at: new Date().toISOString(), destination: dest.label, documents: result.documents, verified: result.verified },
    });
    return result;
  }

  /**
   * One portable file: manifest.json, vault.json, index.vault, objects/. A zip
   * with nothing compressed (ciphertext doesn't), so any tool can open it and
   * see exactly how little it says.
   */
  async exportArchive(onProgress?: (done: number, total: number) => void): Promise<{ chunks: Bytes[]; fileName: string; documents: number; verified: boolean; problems: string[] }> {
    if (!this.vmk) throw new Error("locked");
    const engine = this.requireEngine();
    await engine.sync();
    const objects = await this.api.listObjects();
    const chunks: Bytes[] = [];
    const zip = new Zip((err, chunk) => {
      if (err) throw err;
      chunks.push(chunk as Bytes);
    });
    const add = (name: string, data: Uint8Array) => {
      const file = new ZipPassThrough(name);
      zip.add(file);
      file.push(data, true);
    };

    const total = objects.length + 1;
    let done = 0;
    add("manifest.json", utf8(JSON.stringify({
      format: "family-vault-backup", formatVersion: 1, createdAt: new Date().toISOString(), objectCount: objects.length,
    }, null, 2)));
    add(VAULT_JSON_PATH, (await this.api.vaultJson()).data);
    const index = await this.api.getIndex();
    if (index) add(INDEX_PATH, index.data);
    for (const o of objects) {
      for (let part = 0; part < o.parts; part++) add(objectPath(o.id, part), await this.api.getPart(o.id, part));
      const sc = o.hasSidecar ? await this.api.getSidecar(o.id) : null;
      if (sc) add(sidecarPath(o.id), sc.data);
      onProgress?.(++done, total);
    }
    zip.end();
    onProgress?.(total, total);

    // A file nobody has tried to open is a rumour, not a backup (§27.5). Unzip what
    // was just built and check it the way a restore would: the index opens with this
    // vault's key, every document it lists is inside, every label reads.
    const whole = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { whole.set(c, at); at += c.length; }
    const plan = await planRestore(readerFromFiles(unzipSync(whole)), this.vmk);
    const documents = Object.keys(engine.index.entries).length;
    const problems = [...plan.problems];
    if (plan.objects.length !== objects.length) problems.push("Some documents didn't make it into the file.");
    const verified = problems.length === 0;

    await this.setPrefs({ lastExport: { at: new Date().toISOString(), documents, verified } });
    // A plain .zip: any cloud drive takes it, any tool opens it, and all it shows is locked files with meaningless names.
    const day = istDateStamp(); // the family's date, not UTC's: at 3 am IST those differ
    return { chunks: [whole as Bytes], fileName: `family-vault-backup-${day}.zip`, documents, verified, problems };
  }

  // ───────────────────────────── restore (§28) ─────────────────────────────

  /** Opens a backup far enough to say what it is. Nothing is decrypted yet, and nothing is written anywhere. */
  async inspectBackup(source: { archive: Bytes } | { folder: FileSystemDirectoryHandle }): Promise<
    { ok: true; createdAt: string; files: number; hasPassword: boolean; hasRecoveryCode: boolean } | { ok: false }
  > {
    try {
      const reader = "archive" in source
        ? readerFromFiles(unzipSync(source.archive))
        : readerFromProvider(new LocalFolderStorageProvider(source.folder));
      const bytes = await reader.get(VAULT_JSON_PATH);
      if (!bytes) return { ok: false };
      const vault = VaultJsonSchema.parse(JSON.parse(fromUtf8(bytes)));
      this.pendingRestore = { reader, vault, vaultJsonBytes: bytes };
      return {
        ok: true,
        createdAt: vault.createdAt,
        files: (await reader.list()).filter((p) => p.startsWith("objects/") && !p.includes(".meta.") && !/\.p\d+\./.test(p)).length,
        hasPassword: vault.envelopes.some((e) => e.kind === "password"),
        hasRecoveryCode: vault.envelopes.some((e) => e.kind === "recovery-code"),
      };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Disaster recovery: an empty store, a backup, and one secret — the family
   * password or the printed recovery code. The secret opens the backup locally;
   * only then is anything created on the server, and everything uploaded is the
   * backup's own ciphertext, byte for byte.
   */
  async restoreBackup(
    secret: { password: string } | { recoveryCode: string },
    setupToken?: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<
    | { ok: true; documents: number; problems: string[]; needsNewPassword: boolean; needsNewRecoveryCode: boolean }
    | { ok: false; reason: "wrong" | "invalid-code" | "no-backup" | "server"; detail?: string }
  > {
    const pending = this.pendingRestore;
    if (!pending) return { ok: false, reason: "no-backup" };
    const { vault, reader } = pending;

    let vmk: Bytes;
    let authSecret: Bytes;
    const kind = "password" in secret ? "password" : "recovery-code";
    try {
      const envelope = vault.envelopes.find((e) => e.kind === kind);
      if (!envelope) return { ok: false, reason: "wrong" };
      if ("password" in secret) {
        const keys = await derivePasswordKeys(secret.password, fromBase64(envelope.salt), envelope.kdf);
        vmk = await unwrapVmk(envelope, keys.wrappingKey, vault.vaultId);
        authSecret = keys.authSecret;
      } else {
        const parsed = await parseRecoveryCode(secret.recoveryCode);
        if (!parsed.ok) return { ok: false, reason: "invalid-code" };
        const keys = await deriveRecoveryKeys(parsed.code, fromBase64(envelope.salt));
        vmk = await unwrapVmk(envelope, keys.wrappingKey, vault.vaultId);
        authSecret = keys.authSecret;
      }
    } catch {
      return { ok: false, reason: "wrong" };
    }

    const key = await importAesKey(vmk);
    const plan = await planRestore(reader, key);
    try {
      await this.api.setup({
        mode: "restore", setupToken, vaultJson: vault,
        passwordAuthSecret: kind === "password" ? toBase64(authSecret) : undefined,
        recoveryAuthSecret: kind === "recovery-code" ? toBase64(authSecret) : undefined,
        writeAuthKey: toBase64(await deriveWriteAuthKey(vmk, vault.vaultId)),
      });
    } catch (e) {
      return { ok: false, reason: "server", detail: e instanceof HttpError ? e.code : undefined };
    }
    this.api.setWriteAuthKey(await deriveWriteAuthKey(vmk, vault.vaultId));

    const total = plan.objects.length + 1;
    let done = 0;
    for (const o of plan.objects) {
      for (let part = 0; part < o.parts; part++) {
        const data = await reader.get(objectPath(o.id, part));
        if (data) await this.api.putPart(o.id, part, data);
      }
      const sc = o.hasSidecar ? await reader.get(sidecarPath(o.id)) : null;
      if (sc) await this.api.putSidecar(o.id, sc, {});
      onProgress?.(++done, total);
    }
    const indexBytes = plan.index ? await reader.get(INDEX_PATH) : null;
    if (indexBytes) await this.api.putIndex(indexBytes, {});
    onProgress?.(total, total);

    this.pendingRestore = null;
    this.reauth = { kind: kind === "password" ? "password" : "recovery", authSecret: toBase64(authSecret) };
    await this.local.wipe(); // whatever this device remembered belongs to some other vault
    await this.fetchVaultJson(true);
    await this.finishUnlock(vmk, kind === "password" ? "password" : "recovery");
    if (!indexBytes) await this.requireEngine().rebuild().catch(() => {});
    await this.loadConfig();
    return {
      ok: true,
      documents: Object.keys(this.requireEngine().index.entries).length,
      problems: plan.problems,
      needsNewPassword: kind !== "password",
      needsNewRecoveryCode: kind !== "recovery-code",
    };
  }

  signOutEverywhere() { return this.api.signOutEverywhere().then(() => this.lock()); }

  // ───────────────────────────── helpers ─────────────────────────────

  private async readJson<T>(key: string): Promise<T | null> {
    const blob = await this.local.getBlob(key).catch(() => undefined);
    if (!blob) return null;
    try {
      return JSON.parse(fromUtf8(blob)) as T;
    } catch {
      return null;
    }
  }
}

class KeyChangedError extends Error {}
