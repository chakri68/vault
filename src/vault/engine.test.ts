import { describe, expect, it } from "vitest";
import { importAesKey } from "@/crypto/aes";
import { type Bytes, equalBytes, randomBytes, utf8 } from "@/crypto/bytes";
import { generateVmk } from "@/crypto/envelopes";
import { MemoryStorageProvider } from "@/storage/memory";
import { IntegrityError, type NewDocument, VaultEngine } from "./engine";
import { INDEX_PATH, objectPath, sidecarPath } from "./index-model";
import { MemoryLocalStore } from "./local-store";
import { ProviderRemote } from "./remote";

const KB = 1024;

function doc(name: string, content: Bytes = randomBytes(2000), over: Partial<NewDocument["meta"]> = {}): NewDocument {
  return {
    content, extension: "pdf", mimeType: "application/pdf",
    meta: { name, ownerProfileIds: [], tags: [], ...over },
  };
}

async function setup() {
  const provider = new MemoryStorageProvider();
  const vmk = await importAesKey(generateVmk());
  const device = async (opts: { admin?: boolean; local?: MemoryLocalStore; partSize?: number } = {}) => {
    const local = opts.local ?? new MemoryLocalStore();
    const engine = new VaultEngine({
      remote: new ProviderRemote(provider), local, vmk, isAdmin: () => opts.admin ?? true, partSize: opts.partSize,
    });
    await engine.open();
    return { engine, local };
  };
  return { provider, vmk, device };
}

/** the engine pushes in the background after an edit; wait for it to settle */
async function settled(engine: VaultEngine) {
  for (let i = 0; i < 200; i++) {
    if (!engine.getStatus().syncing && (await engine.sync())) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("engine did not settle");
}

describe("upload and fetch", () => {
  it("stores only ciphertext, under opaque names, and reads back byte-identical", async () => {
    const { provider, device } = await setup();
    const { engine } = await device();
    const content = utf8("%PDF-1.7 passport of LAKSHMI REDDY Z1234567 ".repeat(40));
    const { ids, synced } = await engine.addDocuments([doc("Passport — Mom", content, { category: "identity", tags: ["travel"] })]);
    expect(synced).toBe(true);

    const files = await provider.list();
    expect(files.map((f) => f.path).sort()).toEqual([INDEX_PATH, objectPath(ids[0]), sidecarPath(ids[0])].sort());
    for (const f of files) {
      const text = new TextDecoder("latin1").decode((await provider.get(f.path)).data);
      for (const needle of ["Passport", "Mom", "LAKSHMI", "Z1234567", "identity", "travel", "pdf"]) {
        expect(text.includes(needle), `${needle} in ${f.path}`).toBe(false);
      }
    }

    // a second device, nothing cached: fetches from the store
    const other = (await device()).engine;
    expect(other.index.entries[ids[0]].name).toBe("Passport — Mom");
    const fetched = await other.fetchDocument(ids[0]);
    expect(equalBytes(fetched.content, content)).toBe(true);
    expect(await other.isOnDevice(ids[0])).toBe(true);
  });

  it("writes a batch as N objects and one index update", async () => {
    const { provider, device } = await setup();
    const { engine } = await device();
    await settled(engine); // a brand-new vault writes its empty index first
    const n = (v: string) => Number(v.slice(1)); // memory provider versions are a global write counter, v<n>
    const before = n((await provider.get(INDEX_PATH)).version);
    await engine.addDocuments(Array.from({ length: 8 }, (_, i) => doc(`Doc ${i}`)));
    await settled(engine);
    expect(Object.keys(engine.index.entries)).toHaveLength(8);
    // 8 object writes, then the index exactly once; the 8 sidecars come after and don't touch it
    expect(n((await provider.get(INDEX_PATH)).version)).toBe(before + 9);
    const last = Math.max(...(await provider.list()).map((f) => n(f.version)));
    expect(last).toBe(before + 17);
  });

  it("handles objects split across parts", async () => {
    const { provider, device } = await setup();
    const { engine } = await device({ partSize: 8 * KB });
    const content = randomBytes(40 * KB);
    const { ids } = await engine.addDocuments([doc("Big scan", content)]);
    const parts = (await provider.list(`objects/${ids[0]}`)).filter((f) => !f.path.includes(".meta."));
    expect(parts.length).toBeGreaterThan(1);
    const other = (await device()).engine;
    expect(equalBytes((await other.fetchDocument(ids[0])).content, content)).toBe(true);
  });

  it("detects duplicates by plaintext checksum, locally", async () => {
    const { device } = await setup();
    const { engine } = await device();
    const content = randomBytes(500);
    const { ids } = await engine.addDocuments([doc("Aadhaar — Chakri", content)]);
    const checksum = engine.index.entries[ids[0]].checksum;
    expect(engine.findDuplicate(checksum)?.name).toBe("Aadhaar — Chakri");
    expect(engine.findDuplicate("f".repeat(64))).toBeUndefined();
  });

  it("refuses a tampered object instead of returning garbage, and recovers from a bad cached copy", async () => {
    const { provider, device } = await setup();
    const a = await device();
    const content = randomBytes(3000);
    const { ids } = await a.engine.addDocuments([doc("Deed", content)]);

    // damaged in the cache, intact in the store: falls through to the good copy
    a.local.objects.get(ids[0])![0][500] ^= 0xff;
    expect(equalBytes((await a.engine.fetchDocument(ids[0])).content, content)).toBe(true);

    // damaged in the store: fails loudly
    provider.corrupt(objectPath(ids[0]), 5000);
    const b = await device();
    await expect(b.engine.fetchDocument(ids[0])).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe("concurrency (§9)", () => {
  it("two devices editing at once both keep their changes", async () => {
    const { device } = await setup();
    const mom = (await device()).engine;
    const { ids } = await mom.addDocuments([doc("Passport")]);
    const dad = (await device()).engine;

    // both start from the same index version, then edit different fields
    await Promise.all([
      mom.updateMeta(ids[0], { name: "Passport — Mom" }),
      dad.updateMeta(ids[0], { tags: ["travel"], expiryDate: "2031-03-12" }),
    ]);
    await settled(mom);
    await settled(dad);
    await mom.refresh();
    await dad.refresh();

    for (const e of [mom.index.entries[ids[0]], dad.index.entries[ids[0]]]) {
      expect(e.name).toBe("Passport — Mom");
      expect(e.tags).toEqual(["travel"]);
      expect(e.document?.expiryDate).toBe("2031-03-12");
    }
  });

  it("concurrent uploads from two devices never clobber each other", async () => {
    const { device } = await setup();
    const mom = (await device()).engine;
    const dad = (await device()).engine;
    await Promise.all([
      mom.addDocuments([doc("A"), doc("B"), doc("C")]),
      dad.addDocuments([doc("D"), doc("E")]),
    ]);
    await settled(mom);
    await settled(dad);
    const fresh = (await device()).engine;
    expect(Object.values(fresh.index.entries).map((e) => e.name).sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("a rename reaches the sidecar, so it survives losing the index", async () => {
    const { provider, device } = await setup();
    const { engine } = await device();
    const { ids } = await engine.addDocuments([doc("scan0004")]);
    await engine.updateMeta(ids[0], { name: "Property deed", note: "original with the bank" });
    await settled(engine);

    await provider.delete(INDEX_PATH);
    const fresh = new VaultEngine({ remote: new ProviderRemote(provider), local: new MemoryLocalStore(), vmk: (engine as unknown as { vmk: CryptoKey }).vmk });
    await expect(fresh.open()).rejects.toThrow("index unreadable");
    await fresh.rebuild();
    expect(fresh.index.entries[ids[0]].name).toBe("Property deed");
    expect(fresh.index.entries[ids[0]].note).toBe("original with the bank");
  });
});

describe("trash, purge and lifecycle (§7.4, §23)", () => {
  it("trash is reversible and index-only; permanent delete removes every file", async () => {
    const { provider, device } = await setup();
    const { engine } = await device({ partSize: 8 * KB });
    const { ids } = await engine.addDocuments([doc("Old bill", randomBytes(30 * KB))]);
    const id = ids[0];
    const filesBefore = (await provider.list("objects/")).length;

    await engine.trash(id);
    await settled(engine);
    expect(engine.index.entries[id].state).toBe("trashed");
    expect((await provider.list("objects/")).length).toBe(filesBefore); // the object didn't move

    await engine.restore(id);
    await settled(engine);
    expect(engine.index.entries[id].state).toBe("active");

    await engine.deletePermanently(id);
    await settled(engine);
    expect(engine.index.entries[id]).toBeUndefined();
    expect(engine.index.tombstones[id]).toBeDefined();
    expect(await provider.list("objects/")).toHaveLength(0);
  });

  it("purges trash past retention, moves expired temporary files to trash, and leaves the rest", async () => {
    const { device, provider, vmk } = await setup();
    let clock = Date.parse("2026-09-01T00:00:00Z");
    const engine = new VaultEngine({
      remote: new ProviderRemote(provider), local: new MemoryLocalStore(), vmk, now: () => new Date(clock),
    });
    await engine.open();
    const { ids } = await engine.addDocuments([
      doc("Keeper"),
      doc("To purge"),
      doc("Boarding pass", randomBytes(100), { temporary: { expiresAt: "2026-09-02T00:00:00Z" } }),
    ]);
    await engine.trash(ids[1]);
    await settled(engine);

    clock += 3 * 86_400_000;
    let r = await engine.runLifecycle();
    expect(r.expired).toEqual([ids[2]]);
    expect(r.purged).toEqual([]);

    clock += 30 * 86_400_000;
    r = await engine.runLifecycle();
    await settled(engine);
    expect(r.purged.sort()).toEqual([ids[1], ids[2]].sort());
    expect(Object.keys(engine.index.entries)).toEqual([ids[0]]);

    const fresh = (await device()).engine;
    expect(Object.keys(fresh.index.entries)).toEqual([ids[0]]);
  });

  it("a member device never purges", async () => {
    const { provider, vmk } = await setup();
    let clock = Date.parse("2026-09-01T00:00:00Z");
    const engine = new VaultEngine({
      remote: new ProviderRemote(provider), local: new MemoryLocalStore(), vmk, now: () => new Date(clock), isAdmin: () => false,
    });
    await engine.open();
    const { ids } = await engine.addDocuments([doc("Old")]);
    await engine.trash(ids[0]);
    clock += 90 * 86_400_000;
    expect((await engine.runLifecycle()).purged).toEqual([]);
    expect(engine.index.entries[ids[0]]).toBeDefined();
  });
});

describe("orphans and rebuild (§7.8, §8.4)", () => {
  it("an upload that dies before the index write leaves a named, recoverable orphan", async () => {
    const { provider, device } = await setup();
    const a = await device();
    await a.engine.addDocuments([doc("Already here")]);

    provider.failNext = { op: "put", match: /^index\.vault$/, error: new Error("boom") };
    const { ids, synced } = await a.engine.addDocuments([doc("Passport — Dad")]);
    expect(synced).toBe(false);

    // another device sees the object in the store, but not in the index
    const b = (await device()).engine;
    expect(b.index.entries[ids[0]]).toBeUndefined();
    const orphans = await b.findOrphans();
    expect(orphans).toEqual([expect.objectContaining({ id: ids[0], name: "Passport — Dad", readable: true })]);

    await b.recoverOrphans([ids[0]]);
    expect(b.index.entries[ids[0]].name).toBe("Passport — Dad");
    expect(await b.findOrphans()).toEqual([]);
  });

  it("the first device also finishes the job itself on its next sync", async () => {
    const { provider, device } = await setup();
    const a = await device();
    provider.failNext = { op: "put", match: /^index\.vault$/, error: new Error("boom") };
    const { ids } = await a.engine.addDocuments([doc("Retry me")]);
    await settled(a.engine);
    expect((await device()).engine.index.entries[ids[0]].name).toBe("Retry me");
  });

  it("rebuilds the whole vault from the labels on the files, with the index deleted", async () => {
    const { provider, device, vmk } = await setup();
    const a = (await device()).engine;
    await a.saveProfile({ id: "p-mom", displayName: "Mom", tint: "photos" });
    await settled(a);
    const docs = Array.from({ length: 25 }, (_, i) =>
      doc(`Document ${i}`, randomBytes(300 + i), { ownerProfileIds: ["p-mom"], category: i % 2 ? "identity" : "finance", tags: [`t${i}`] }));
    const { ids } = await a.addDocuments(docs);
    await a.updateMeta(ids[3], { name: "Renamed after upload" });
    await settled(a);

    await provider.delete(INDEX_PATH);
    const b = new VaultEngine({ remote: new ProviderRemote(provider), local: new MemoryLocalStore(), vmk });
    await expect(b.open()).rejects.toThrow();
    const seen: number[] = [];
    const result = await b.rebuild((done) => seen.push(done));

    expect(result).toEqual({ recovered: 25, unreadable: 0 });
    expect(seen.at(-1)).toBe(25);
    expect(Object.keys(b.index.entries).sort()).toEqual([...ids].sort());
    expect(b.index.entries[ids[3]].name).toBe("Renamed after upload");
    expect(b.index.entries[ids[7]].tags).toEqual(["t7"]);
    expect(b.index.profiles.find((p) => p.id === "p-mom")?.displayName).toBe("Mom"); // from the hints
    for (const id of ids) {
      expect(a.index.entries[id].checksum).toBe(b.index.entries[id].checksum);
    }
    // and it wrote a fresh index back
    const c = (await device()).engine;
    expect(Object.keys(c.index.entries)).toHaveLength(25);
  });

  it("falls back to the header inside the object when the sidecar is gone or damaged", async () => {
    const { provider, device, vmk } = await setup();
    const a = (await device()).engine;
    const { ids } = await a.addDocuments([doc("No sidecar"), doc("Bad sidecar")]);
    await provider.delete(sidecarPath(ids[0]));
    provider.corrupt(sidecarPath(ids[1]), 200);
    await provider.delete(INDEX_PATH);

    const b = new VaultEngine({ remote: new ProviderRemote(provider), local: new MemoryLocalStore(), vmk });
    await b.open().catch(() => {});
    expect(await b.rebuild()).toEqual({ recovered: 2, unreadable: 0 });
    expect(Object.values(b.index.entries).map((e) => e.name).sort()).toEqual(["Bad sidecar", "No sidecar"]);
  });

  it("repairing with a readable index keeps trash state and doesn't resurrect deletions", async () => {
    const { provider, device } = await setup();
    const a = (await device()).engine;
    const { ids } = await a.addDocuments([doc("Active"), doc("Trashed"), doc("Deleted")]);
    await a.trash(ids[1]);
    await settled(a);

    // simulate an interrupted permanent delete: tombstone written, files left behind
    provider.failNext = { op: "delete", match: /objects\//, error: new Error("boom") };
    await a.deletePermanently(ids[2]);
    await a.sync();

    await a.rebuild();
    expect(a.index.entries[ids[0]].state).toBe("active");
    expect(a.index.entries[ids[1]].state).toBe("trashed");
    expect(a.index.entries[ids[2]]).toBeUndefined();
  });
});

describe("offline (§17)", () => {
  it("opens from the device with no network at all", async () => {
    const { provider, device, vmk } = await setup();
    const a = await device();
    const content = randomBytes(900);
    const { ids } = await a.engine.addDocuments([doc("Passport — Mom", content)]);

    const dead = new ProviderRemote(provider);
    for (const m of ["getIndex", "putIndex", "getPart", "putPart", "getSidecar", "putSidecar", "deleteObject", "listObjects"] as const) {
      (dead as unknown as Record<string, unknown>)[m] = async () => { throw new TypeError("Failed to fetch"); };
    }
    const offline = new VaultEngine({ remote: dead, local: a.local, vmk });
    await offline.open(); // no throw: the cached index is enough
    expect(offline.index.entries[ids[0]].name).toBe("Passport — Mom");
    expect(equalBytes((await offline.fetchDocument(ids[0])).content, content)).toBe(true);
  });

  it("a device that has the list shows it without waiting for the store, and still hears what changed", async () => {
    const { provider, device, vmk } = await setup();
    const a = await device();
    const { ids } = await a.engine.addDocuments([doc("Passport — Mom")]);
    await settled(a.engine);

    // the store hangs: never answers, never errors
    const hung = new ProviderRemote(provider);
    (hung as unknown as Record<string, unknown>).getIndex = () => new Promise(() => {});
    const slow = new VaultEngine({ remote: hung, local: a.local, vmk });
    const opened = await Promise.race([slow.open().then(() => "opened"), new Promise((r) => setTimeout(() => r("still waiting"), 500))]);
    expect(opened).toBe("opened");
    expect(slow.index.entries[ids[0]].name).toBe("Passport — Mom");
    slow.close();

    // and with a store that does answer, someone else's edit lands shortly after opening
    const other = (await device()).engine;
    await other.updateMeta(ids[0], { name: "Passport — Amma" });
    await settled(other);
    const again = new VaultEngine({ remote: new ProviderRemote(provider), local: a.local, vmk });
    await again.open();
    for (let i = 0; i < 100 && again.index.entries[ids[0]].name !== "Passport — Amma"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(again.index.entries[ids[0]].name).toBe("Passport — Amma");
  });

  it("a device that has never seen the vault does wait: it has nothing else to show", async () => {
    const { device } = await setup();
    const a = await device();
    await a.engine.addDocuments([doc("Only on the store")]);
    await settled(a.engine);
    const fresh = (await device()).engine; // open() has resolved by here
    expect(Object.values(fresh.index.entries).map((e) => e.name)).toEqual(["Only on the store"]);
  });

  it("queues edits and uploads made offline, and replays them through the merge on reconnect", async () => {
    const { provider, device, vmk } = await setup();
    const a = await device();
    const { ids } = await a.engine.addDocuments([doc("Insurance")]);

    // go offline
    let online = false;
    const real = new ProviderRemote(provider);
    const flaky = new Proxy(real, {
      get(target, prop) {
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (!online) return Promise.reject(new TypeError("Failed to fetch"));
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const phone = new VaultEngine({ remote: flaky, local: a.local, vmk });
    await phone.open();
    await phone.updateMeta(ids[0], { name: "Car insurance", expiryDate: "2026-10-10" });
    const added = await phone.addDocuments([doc("Taken at the counter")]);
    expect(added.synced).toBe(false);
    expect(phone.getStatus().problem).toBe("offline");
    expect(phone.getStatus().pending).toBeGreaterThan(0);

    // meanwhile, someone else edits the same document
    const laptop = (await device()).engine;
    await laptop.updateMeta(ids[0], { tags: ["car"] });
    await settled(laptop);

    // the phone is killed and restarted while still offline: the queue is on disk, as ciphertext
    phone.close();
    for (const blob of a.local.blobs.values()) {
      expect(new TextDecoder("latin1").decode(blob).includes("Car insurance")).toBe(false);
    }
    const reopened = new VaultEngine({ remote: flaky, local: a.local, vmk });
    await reopened.open();
    expect(reopened.index.entries[ids[0]].name).toBe("Car insurance");

    online = true;
    await settled(reopened);

    const fresh = (await device()).engine;
    const e = fresh.index.entries[ids[0]];
    expect(e.name).toBe("Car insurance");
    expect(e.document?.expiryDate).toBe("2026-10-10");
    expect(e.tags).toEqual(["car"]); // the laptop's edit survived
    expect(fresh.index.entries[added.ids[0]].name).toBe("Taken at the counter");
    expect((await fresh.fetchDocument(added.ids[0])).header.name).toBe("Taken at the counter");
  });
});

describe("the 'changes not saved' warning", () => {
  it("says what failed, and doesn't outlive its cause", async () => {
    const { provider, device } = await setup();
    const { engine } = await device();
    await settled(engine);

    provider.failNext = { op: "put", match: /^index\.vault$/, error: Object.assign(new Error("boom"), { status: 503, code: "storage-unavailable", detail: "GitHub rate limit reached" }) };
    const { ids } = await engine.addDocuments([doc("Will be cancelled")]);
    expect(engine.getStatus().problem).toBe("server");
    expect(engine.getStatus().detail).toMatch(/HTTP 503 storage-unavailable · GitHub rate limit reached/);
    expect(engine.getStatus().detail).not.toContain(ids[0]); // never an id

    await settled(engine); // the retry carries it
    expect(engine.getStatus().problem).toBeUndefined();
    expect(engine.getStatus().detail).toBeUndefined();
  });

  it("clears when the failed work stops being needed, even though no sync ever 'succeeds' for it", async () => {
    const { provider, vmk } = await setup();
    let down = true;
    const real = new ProviderRemote(provider);
    const flaky = new Proxy(real, {
      get(target, prop) {
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => (down && String(prop).startsWith("put")
          ? Promise.reject(Object.assign(new Error("x"), { status: 500, code: "server" }))
          : (v as (...a: unknown[]) => unknown).apply(target, args));
      },
    });
    const engine = new VaultEngine({ remote: flaky, local: new MemoryLocalStore(), vmk });
    await engine.open();
    await engine.sync();
    expect(engine.getStatus().problem).toBe("server");

    // the store recovers, and by then there is nothing of ours left to push that it doesn't already have
    down = false;
    await settled(engine);
    expect(engine.getStatus().problem).toBeUndefined();
    expect(await engine.sync()).toBe(true);
    expect(engine.getStatus().problem).toBeUndefined();
  });
});

describe("permanent delete", () => {
  it("a hiccup removing the files doesn't claim the change wasn't saved, and the files still go", async () => {
    const { provider, device } = await setup();
    const { engine } = await device();
    const { ids } = await engine.addDocuments([doc("Delete me")]);
    await settled(engine);

    provider.failNext = { op: "delete", match: /objects\//, error: Object.assign(new Error("lag"), { name: "PreconditionFailedError" }) };
    const alarms: string[] = [];
    (engine as unknown as { onChange: (i: unknown, st: { problem?: string }) => void }).onChange = (_i, st) => { if (st.problem) alarms.push(st.problem); };
    await engine.deletePermanently(ids[0]);
    await settled(engine);
    expect(engine.index.tombstones[ids[0]]).toBeDefined(); // the delete itself is saved
    expect(alarms).toEqual([]); // so at no point did it claim otherwise
    expect(await provider.list("objects/")).toEqual([]); // and the retry removed the files
    expect(engine.getStatus().pending).toBe(0);
  });
});
