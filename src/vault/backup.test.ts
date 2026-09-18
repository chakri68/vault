import { describe, expect, it } from "vitest";
import { importAesKey } from "@/crypto/aes";
import { type Bytes, equalBytes, randomBytes, utf8 } from "@/crypto/bytes";
import { generateVmk } from "@/crypto/envelopes";
import { MemoryStorageProvider } from "@/storage/memory";
import { parseObjectPath } from "@/storage/provider";
import { MANIFEST_PATH, mirrorTo, planRestore, readerFromProvider, verifyBackup } from "./backup";
import { VaultEngine } from "./engine";
import { INDEX_PATH, objectPath } from "./index-model";
import { MemoryLocalStore } from "./local-store";
import { ProviderRemote } from "./remote";

const vaultJson = utf8(JSON.stringify({ format: "family-vault", note: "stands in for the real vault.json" }));

async function vaultWithDocs(n: number) {
  const primary = new MemoryStorageProvider();
  const vmk = await importAesKey(generateVmk());
  const engine = new VaultEngine({ remote: new ProviderRemote(primary), local: new MemoryLocalStore(), vmk, partSize: 8 * 1024 });
  await engine.open();
  const contents = Array.from({ length: n }, (_, i) => randomBytes(500 + i * 9000));
  const { ids } = await engine.addDocuments(contents.map((content, i) => ({
    content, extension: "pdf", mimeType: "application/pdf",
    meta: { name: `Passport — Person ${i}`, ownerProfileIds: [], tags: ["travel"], category: "identity" },
  })));
  await engine.sync();
  return { primary, vmk, engine, ids, contents };
}

describe("backup: mirror and verify (§27)", () => {
  it("copies the store as-is, proves it by reading it back, and holds no plaintext", async () => {
    const { primary, vmk } = await vaultWithDocs(4);
    const dest = new MemoryStorageProvider();
    const result = await mirrorTo(dest, { remote: new ProviderRemote(primary), vaultJson }, vmk);

    expect(result.verified).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.documents).toBe(4);

    const src = (await primary.list("objects/")).map((f) => f.path).sort();
    const dst = (await dest.list("objects/")).map((f) => f.path).sort();
    expect(dst).toEqual(src); // identical layout, opaque names
    for (const path of dst) expect(equalBytes((await dest.get(path)).data, (await primary.get(path)).data)).toBe(true);

    for (const f of await dest.list()) {
      if (f.path === "vault.json") continue;
      const text = new TextDecoder("latin1").decode((await dest.get(f.path)).data);
      for (const needle of ["Passport", "Person", "travel", "identity", "objects/"]) expect(text.includes(needle), `${needle} in ${f.path}`).toBe(false);
    }
  });

  it("is incremental: a second run re-copies only what can have changed", async () => {
    const { primary, vmk, engine } = await vaultWithDocs(3);
    const dest = new MemoryStorageProvider();
    const first = await mirrorTo(dest, { remote: new ProviderRemote(primary), vaultJson }, vmk);
    expect(first.skipped).toBe(0);
    const oldParts = (await primary.list("objects/")).filter((f) => parseObjectPath(f.path)?.kind === "part").length;

    await engine.addDocuments([{ content: randomBytes(100), extension: "txt", mimeType: "text/plain", meta: { name: "New", ownerProfileIds: [], tags: [] } }]);
    await engine.sync();
    const second = await mirrorTo(dest, { remote: new ProviderRemote(primary), vaultJson }, vmk);
    expect(second.skipped).toBe(oldParts); // every old part skipped; only the new document's content copied
    expect(second.verified).toBe(true);
    expect(second.documents).toBe(4);
  });

  it("drops documents from the backup once they're permanently deleted from the vault", async () => {
    const { primary, vmk, engine, ids } = await vaultWithDocs(2);
    const dest = new MemoryStorageProvider();
    await mirrorTo(dest, { remote: new ProviderRemote(primary), vaultJson }, vmk);
    await engine.deletePermanently(ids[0]);
    await engine.sync();
    const again = await mirrorTo(dest, { remote: new ProviderRemote(primary), vaultJson }, vmk);
    expect(again.verified).toBe(true);
    expect((await dest.list(`objects/${ids[0]}`)).length).toBe(0);
  });

  it("notices a damaged file, a missing file, and a backup made with another key", async () => {
    const { primary, vmk, ids } = await vaultWithDocs(2);
    const dest = new MemoryStorageProvider();
    await mirrorTo(dest, { remote: new ProviderRemote(primary), vaultJson }, vmk);

    dest.corrupt(objectPath(ids[0]), 300);
    let check = await verifyBackup(dest, vmk);
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toMatch(/doesn't match/);

    await dest.delete(objectPath(ids[1]));
    check = await verifyBackup(dest, vmk);
    expect(check.problems.join(" ")).toMatch(/missing/);

    const stranger = await importAesKey(generateVmk());
    expect((await verifyBackup(dest, stranger)).ok).toBe(false);
  });
});

describe("disaster recovery (§28.1): only the backup and the key survive", () => {
  async function restoreInto(fresh: MemoryStorageProvider, backup: MemoryStorageProvider, vmk: CryptoKey) {
    const reader = readerFromProvider(backup);
    const plan = await planRestore(reader, vmk);
    const remote = new ProviderRemote(fresh);
    for (const o of plan.objects) {
      for (let part = 0; part < o.parts; part++) await remote.putPart(o.id, part, (await reader.get(objectPath(o.id, part)))!);
      if (o.hasSidecar) await remote.putSidecar(o.id, (await reader.get(`objects/${o.id}.meta.vault`))!, {});
    }
    if (plan.index) await remote.putIndex((await reader.get(INDEX_PATH))!, {});
    return plan;
  }

  it("restores into a fresh provider, byte-identical", async () => {
    const { primary, vmk, ids, contents } = await vaultWithDocs(5);
    const backup = new MemoryStorageProvider();
    await mirrorTo(backup, { remote: new ProviderRemote(primary), vaultJson }, vmk);

    // the primary is gone
    const fresh = new MemoryStorageProvider();
    const plan = await restoreInto(fresh, backup, vmk);
    expect(plan.problems).toEqual([]);

    const engine = new VaultEngine({ remote: new ProviderRemote(fresh), local: new MemoryLocalStore(), vmk });
    await engine.open();
    expect(Object.keys(engine.index.entries).sort()).toEqual([...ids].sort());
    for (let i = 0; i < ids.length; i++) {
      const doc = await engine.fetchDocument(ids[i]);
      expect(equalBytes(doc.content, contents[i] as Bytes)).toBe(true);
      expect(doc.header.name).toBe(`Passport — Person ${i}`);
    }
    expect(await fresh.get(MANIFEST_PATH).catch(() => null)).toBeNull(); // the manifest belongs to the backup, not the vault
  });

  it("survives a backup whose index is gone, and skips a document that's damaged", async () => {
    const { primary, vmk, ids } = await vaultWithDocs(3);
    const backup = new MemoryStorageProvider();
    await mirrorTo(backup, { remote: new ProviderRemote(primary), vaultJson }, vmk);
    await backup.delete(INDEX_PATH);
    backup.corrupt(objectPath(ids[2]), 60); // inside the wrapped key: the label can't be opened

    const fresh = new MemoryStorageProvider();
    const plan = await restoreInto(fresh, backup, vmk);
    expect(plan.index).toBeNull();
    expect(plan.objects.map((o) => o.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(plan.problems.length).toBeGreaterThan(0);

    const engine = new VaultEngine({ remote: new ProviderRemote(fresh), local: new MemoryLocalStore(), vmk });
    await engine.open().catch(() => {});
    await engine.rebuild();
    expect(Object.keys(engine.index.entries).sort()).toEqual([ids[0], ids[1]].sort());
  });

  it("a backup is useless without the key", async () => {
    const { primary, vmk } = await vaultWithDocs(2);
    const backup = new MemoryStorageProvider();
    await mirrorTo(backup, { remote: new ProviderRemote(primary), vaultJson }, vmk);
    const plan = await planRestore(readerFromProvider(backup), await importAesKey(generateVmk()));
    expect(plan.index).toBeNull();
    expect(plan.objects).toEqual([]);
  });
});
