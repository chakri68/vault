import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { IndexEntry, VaultIndex } from "@/schemas/index";
import { MUTABLE_FIELDS, applyPatch, emptyIndex, entryFromHeader, setState } from "./index-model";
import { mergeIndexes, pruneTombstones, sameIndex } from "./merge";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function entry(id: string, name = "Doc"): IndexEntry {
  return entryFromHeader(
    {
      version: 1, id, name, extension: "pdf", mimeType: "application/pdf", plaintextSize: 10,
      checksum: "a".repeat(64), ownerProfileIds: [], tags: [], createdAt: iso(T0), updatedAt: iso(T0),
    },
    { encryptedSize: 16500, partCount: 1 },
  );
}

function base(ids: string[]): VaultIndex {
  const index = emptyIndex(new Date(T0));
  for (const id of ids) index.entries[id] = entry(id);
  return index;
}

// ───────────── generated concurrent-edit scenarios ─────────────

const IDS = ["a", "b", "c", "d"];

type Op =
  | { kind: "rename"; id: string; name: string }
  | { kind: "tag"; id: string; tags: string[] }
  | { kind: "expiry"; id: string; date: string | undefined }
  | { kind: "note"; id: string; note: string | undefined }
  | { kind: "trash"; id: string }
  | { kind: "restore"; id: string }
  | { kind: "add"; id: string }
  | { kind: "purge"; id: string }
  | { kind: "profile"; id: string; name: string }
  | { kind: "profile-delete"; id: string }
  | { kind: "setting"; value: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("rename" as const), id: fc.constantFrom(...IDS), name: fc.string({ minLength: 1, maxLength: 8 }) }),
  fc.record({ kind: fc.constant("tag" as const), id: fc.constantFrom(...IDS), tags: fc.array(fc.constantFrom("x", "y", "z"), { maxLength: 3 }) }),
  fc.record({ kind: fc.constant("expiry" as const), id: fc.constantFrom(...IDS), date: fc.option(fc.constantFrom("2027-01-01", "2031-03-12"), { nil: undefined }) }),
  fc.record({ kind: fc.constant("note" as const), id: fc.constantFrom(...IDS), note: fc.option(fc.string({ maxLength: 6 }), { nil: undefined }) }),
  fc.record({ kind: fc.constant("trash" as const), id: fc.constantFrom(...IDS) }),
  fc.record({ kind: fc.constant("restore" as const), id: fc.constantFrom(...IDS) }),
  fc.record({ kind: fc.constant("add" as const), id: fc.constantFrom("e", "f", "g") }),
  fc.record({ kind: fc.constant("purge" as const), id: fc.constantFrom(...IDS) }),
  fc.record({ kind: fc.constant("profile" as const), id: fc.constantFrom("mom", "dad"), name: fc.string({ minLength: 1, maxLength: 6 }) }),
  fc.record({ kind: fc.constant("profile-delete" as const), id: fc.constantFrom("mom", "dad") }),
  fc.record({ kind: fc.constant("setting" as const), value: fc.integer({ min: 7, max: 90 }) }),
);

/** A device's session: a list of ops, each at a (possibly colliding) wall-clock time. */
const sessionArb = fc.array(fc.tuple(opArb, fc.integer({ min: 1, max: 40 })), { maxLength: 8 });

function run(start: VaultIndex, session: Array<[Op, number]>): VaultIndex {
  const index = structuredClone(start);
  for (const [op, tick] of session) {
    const now = new Date(T0 + tick * 1000);
    const e = "id" in op ? index.entries[op.id] : undefined;
    switch (op.kind) {
      case "rename": if (e) index.entries[op.id] = applyPatch(e, { name: op.name }, now); break;
      case "tag": if (e) index.entries[op.id] = applyPatch(e, { tags: op.tags }, now); break;
      case "expiry": if (e) index.entries[op.id] = applyPatch(e, { expiryDate: op.date }, now); break;
      case "note": if (e) index.entries[op.id] = applyPatch(e, { note: op.note }, now); break;
      case "trash": if (e) index.entries[op.id] = setState(e, "trashed", now); break;
      case "restore": if (e) index.entries[op.id] = setState(e, "active", now); break;
      case "add": if (!e && !index.tombstones[op.id]) index.entries[op.id] = entry(op.id, `new-${op.id}`); break;
      case "purge":
        if (e) {
          delete index.entries[op.id];
          index.tombstones[op.id] = { deletedAt: now.toISOString(), purgeAfter: now.toISOString(), shredded: false };
        }
        break;
      case "profile": {
        const prev = index.profiles.find((p) => p.id === op.id);
        if (prev?.deletedAt) break; // a deleted profile is a tombstone; a new person gets a new id
        index.profiles = index.profiles.filter((p) => p.id !== op.id);
        index.profiles.push({ id: op.id, displayName: op.name, createdAt: prev?.createdAt ?? now.toISOString(), updatedAt: now.toISOString() });
        break;
      }
      case "profile-delete":
        index.profiles = index.profiles.map((p) => (p.id === op.id ? { ...p, deletedAt: now.toISOString(), updatedAt: now.toISOString() } : p));
        break;
      case "setting":
        index.settings = { ...index.settings, trashRetentionDays: { value: op.value, v: Math.max((index.settings.trashRetentionDays?.v ?? 0) + 1, now.getTime()) } };
        break;
    }
    index.updatedAt = now.toISOString();
  }
  return index;
}

const RUNS = { numRuns: 400 };

describe("merge is a join (property-based)", () => {
  it("commutative: it doesn't matter who merges whom", () => {
    fc.assert(fc.property(sessionArb, sessionArb, (s1, s2) => {
      const start = base(IDS);
      const a = run(start, s1), b = run(start, s2);
      expect(sameIndex(mergeIndexes(a, b), mergeIndexes(b, a))).toBe(true);
    }), RUNS);
  });

  it("associative: three devices converge regardless of order", () => {
    fc.assert(fc.property(sessionArb, sessionArb, sessionArb, (s1, s2, s3) => {
      const start = base(IDS);
      const a = run(start, s1), b = run(start, s2), c = run(start, s3);
      const left = mergeIndexes(mergeIndexes(a, b), c);
      const right = mergeIndexes(a, mergeIndexes(b, c));
      expect(sameIndex(left, right)).toBe(true);
    }), RUNS);
  });

  it("idempotent: merging again changes nothing", () => {
    fc.assert(fc.property(sessionArb, sessionArb, (s1, s2) => {
      const start = base(IDS);
      const a = run(start, s1), b = run(start, s2);
      const m = mergeIndexes(a, b);
      expect(sameIndex(mergeIndexes(m, a), m)).toBe(true);
      expect(sameIndex(mergeIndexes(m, b), m)).toBe(true);
      expect(sameIndex(mergeIndexes(m, m), m)).toBe(true);
    }), RUNS);
  });

  it("a device's own later edit survives a merge with a stale copy of itself", () => {
    fc.assert(fc.property(sessionArb, sessionArb, (s1, s2) => {
      const start = base(IDS);
      const stale = run(start, s1);
      const fresh = run(stale, s2.map(([op, t]) => [op, t + 100] as [Op, number]));
      expect(sameIndex(mergeIndexes(stale, fresh), fresh)).toBe(true);
    }), RUNS);
  });

  it("no document is ever lost except to a tombstone", () => {
    fc.assert(fc.property(sessionArb, sessionArb, (s1, s2) => {
      const start = base(IDS);
      const a = run(start, s1), b = run(start, s2);
      const m = mergeIndexes(a, b);
      for (const id of new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])) {
        expect(!!m.entries[id] || !!m.tombstones[id]).toBe(true);
      }
      for (const id of Object.keys(m.tombstones)) expect(m.entries[id]).toBeUndefined();
    }), RUNS);
  });

  it("every merged field value came from one side, with the newer clock", () => {
    fc.assert(fc.property(sessionArb, sessionArb, (s1, s2) => {
      const start = base(IDS);
      const a = run(start, s1), b = run(start, s2);
      const m = mergeIndexes(a, b);
      for (const [id, e] of Object.entries(m.entries)) {
        const ea = a.entries[id], eb = b.entries[id];
        if (!ea || !eb) continue;
        for (const f of MUTABLE_FIELDS) {
          expect(e.fieldVersions[f]).toBe(Math.max(ea.fieldVersions[f] ?? 0, eb.fieldVersions[f] ?? 0));
        }
      }
    }), RUNS);
  });
});

describe("merge rules, by example (§9.3)", () => {
  it("two members adding different files never conflict", () => {
    const start = base(["a"]);
    const mom = structuredClone(start); mom.entries.m = entry("m", "Passport — Mom");
    const dad = structuredClone(start); dad.entries.d = entry("d", "Visa — Dad");
    expect(Object.keys(mergeIndexes(mom, dad).entries).sort()).toEqual(["a", "d", "m"]);
  });

  it("Mom renames while Dad adds a tag: both changes survive", () => {
    const start = base(["a"]);
    const mom = structuredClone(start); mom.entries.a = applyPatch(mom.entries.a, { name: "Passport — Mom" }, new Date(T0 + 5000));
    const dad = structuredClone(start); dad.entries.a = applyPatch(dad.entries.a, { tags: ["travel"] }, new Date(T0 + 6000));
    const m = mergeIndexes(mom, dad).entries.a;
    expect(m.name).toBe("Passport — Mom");
    expect(m.tags).toEqual(["travel"]);
  });

  it("same field, two devices: the later write wins, whichever side merges", () => {
    const start = base(["a"]);
    const mom = structuredClone(start); mom.entries.a = applyPatch(mom.entries.a, { name: "Early" }, new Date(T0 + 1000));
    const dad = structuredClone(start); dad.entries.a = applyPatch(dad.entries.a, { name: "Late" }, new Date(T0 + 2000));
    expect(mergeIndexes(mom, dad).entries.a.name).toBe("Late");
    expect(mergeIndexes(dad, mom).entries.a.name).toBe("Late");
  });

  it("clearing a field is an edit like any other", () => {
    const start = base(["a"]);
    start.entries.a = applyPatch(start.entries.a, { expiryDate: "2031-03-12", note: "renew" }, new Date(T0 + 1000));
    const mom = structuredClone(start); mom.entries.a = applyPatch(mom.entries.a, { expiryDate: undefined }, new Date(T0 + 5000));
    const m = mergeIndexes(start, mom).entries.a;
    expect(m.document?.expiryDate).toBeUndefined();
    expect(m.note).toBe("renew");
  });

  it("trash vs rename: the file is in the trash, and the rename rides along", () => {
    const start = base(["a"]);
    const mom = structuredClone(start); mom.entries.a = setState(mom.entries.a, "trashed", new Date(T0 + 5000));
    const dad = structuredClone(start); dad.entries.a = applyPatch(dad.entries.a, { name: "Renamed" }, new Date(T0 + 9000));
    const m = mergeIndexes(mom, dad).entries.a;
    expect(m.state).toBe("trashed");
    expect(m.trashedAt).toBeDefined();
    expect(m.name).toBe("Renamed");
  });

  it("a permanent delete beats any edit, and an offline client can't resurrect it", () => {
    const start = base(["a"]);
    const admin = structuredClone(start);
    delete admin.entries.a;
    admin.tombstones.a = { deletedAt: iso(T0 + 1000), purgeAfter: iso(T0 + 1000), shredded: false };
    const offline = structuredClone(start);
    offline.entries.a = applyPatch(offline.entries.a, { name: "Edited offline, much later" }, new Date(T0 + 999_000));
    for (const m of [mergeIndexes(admin, offline), mergeIndexes(offline, admin)]) {
      expect(m.entries.a).toBeUndefined();
      expect(m.tombstones.a).toBeDefined();
    }
  });

  it("shred is never un-shredded", () => {
    const a = base([]); a.tombstones.x = { deletedAt: iso(T0), purgeAfter: iso(T0), shredded: true };
    const b = base([]); b.tombstones.x = { deletedAt: iso(T0 + 5), purgeAfter: iso(T0 + 5), shredded: false };
    expect(mergeIndexes(a, b).tombstones.x.shredded).toBe(true);
    expect(mergeIndexes(b, a).tombstones.x.shredded).toBe(true);
  });

  it("profiles union, and a deleted profile stays deleted", () => {
    const a = base([]); a.profiles.push({ id: "mom", displayName: "Mom", createdAt: iso(T0), updatedAt: iso(T0) });
    const b = base([]); b.profiles.push({ id: "dad", displayName: "Dad", createdAt: iso(T0), updatedAt: iso(T0) });
    const gone = structuredClone(a); gone.profiles[0] = { ...gone.profiles[0], deletedAt: iso(T0 + 10), updatedAt: iso(T0 + 10) };
    const renamed = structuredClone(a); renamed.profiles[0] = { ...renamed.profiles[0], displayName: "Amma", updatedAt: iso(T0 + 99_000) };
    expect(mergeIndexes(a, b).profiles.map((p) => p.id)).toEqual(["dad", "mom"]);
    expect(mergeIndexes(gone, renamed).profiles[0].deletedAt).toBeDefined();
  });

  it("tombstones are kept well past the trash window, then pruned", () => {
    const index = base([]);
    index.tombstones.x = { deletedAt: iso(T0), purgeAfter: iso(T0), shredded: false };
    const day = 86_400_000;
    expect(pruneTombstones(index, T0 + 60 * day).tombstones.x).toBeDefined();
    expect(pruneTombstones(index, T0 + 181 * day).tombstones.x).toBeUndefined();
  });
});
