import type { DocFacts, DocMeta, FieldVersions, ObjectHeader, Sidecar } from "@/schemas/file";
import type { Category, IndexEntry, VaultIndex, VaultProfile } from "@/schemas/index";

export const DEFAULT_CATEGORIES = [
  "identity", "medical", "finance", "education", "employment", "insurance",
  "travel", "property", "legal", "photos", "receipts", "other",
] as const;

export const objectPath = (id: string, part = 0) =>
  part === 0 ? `objects/${id}.vault` : `objects/${id}.p${part}.vault`;
export const sidecarPath = (id: string) => `objects/${id}.meta.vault`;
export const INDEX_PATH = "index.vault";
export const VAULT_JSON_PATH = "vault.json";

/**
 * The editable fields, flattened. Each is its own last-writer-wins register, so
 * Mom renaming a file while Dad adds a tag keeps both changes (§9.3).
 * `state` carries trashedAt with it — they only make sense together.
 */
export const MUTABLE_FIELDS = [
  "name", "ownerProfileIds", "category", "tags", "note",
  "document.issueDate", "document.expiryDate", "document.issuer", "document.referenceNumber",
  "temporary", "reminders", "state",
] as const;
export type MutableField = (typeof MUTABLE_FIELDS)[number];

/** Fields that live in the sidecar. `state` doesn't: trash is index-only. */
export const SIDECAR_FIELDS = MUTABLE_FIELDS.filter((f) => f !== "state");

export function getField(entry: IndexEntry, field: MutableField): unknown {
  switch (field) {
    case "state":
      return { state: entry.state, trashedAt: entry.trashedAt };
    case "document.issueDate": return entry.document?.issueDate;
    case "document.expiryDate": return entry.document?.expiryDate;
    case "document.issuer": return entry.document?.issuer;
    case "document.referenceNumber": return entry.document?.referenceNumber;
    default:
      return entry[field];
  }
}

export function setField(entry: IndexEntry, field: MutableField, value: unknown): void {
  if (field === "state") {
    const v = value as { state: IndexEntry["state"]; trashedAt?: string };
    entry.state = v.state;
    if (v.trashedAt === undefined) delete entry.trashedAt;
    else entry.trashedAt = v.trashedAt;
    return;
  }
  if (field.startsWith("document.")) {
    const key = field.slice("document.".length) as keyof NonNullable<IndexEntry["document"]>;
    const doc = { ...(entry.document ?? {}) };
    if (value === undefined || value === "") delete doc[key];
    else doc[key] = value as string;
    if (Object.keys(doc).length === 0) delete entry.document;
    else entry.document = doc;
    return;
  }
  const target = entry as Record<string, unknown>;
  if (value === undefined) delete target[field];
  else target[field] = value;
}

/**
 * A hybrid clock: wall time, but never behind what we've already seen for this
 * field. Two devices with skewed clocks still order their own edits correctly.
 */
export function nextVersion(previous: number | undefined, now = Date.now()): number {
  return Math.max((previous ?? 0) + 1, now);
}

export function emptyIndex(now = new Date()): VaultIndex {
  const iso = now.toISOString();
  return {
    version: 1,
    updatedAt: iso,
    entries: {},
    tombstones: {},
    profiles: [],
    categories: DEFAULT_CATEGORIES.map((id): Category => ({
      id, name: id[0].toUpperCase() + id.slice(1), createdAt: iso, updatedAt: iso,
    })),
    settings: {},
  };
}

export function metaOf(source: DocMeta): DocMeta {
  return {
    name: source.name,
    ownerProfileIds: [...source.ownerProfileIds],
    category: source.category,
    tags: [...source.tags],
    note: source.note,
    document: source.document ? { ...source.document } : undefined,
    temporary: source.temporary ? { ...source.temporary } : undefined,
    reminders: source.reminders ? [...source.reminders] : undefined,
  };
}

export function factsOf(source: DocFacts): DocFacts {
  return {
    id: source.id,
    extension: source.extension,
    mimeType: source.mimeType,
    plaintextSize: source.plaintextSize,
    checksum: source.checksum,
    createdByProfileId: source.createdByProfileId,
    createdAt: source.createdAt,
  };
}

function prune<T extends object>(value: T): T {
  for (const k of Object.keys(value) as Array<keyof T>) if (value[k] === undefined) delete value[k];
  return value;
}

export function entryFromHeader(
  header: ObjectHeader,
  stored: { encryptedSize: number; partCount: number },
  fieldVersions?: FieldVersions,
): IndexEntry {
  const created = Date.parse(header.createdAt) || 0;
  return prune({
    ...factsOf(header),
    ...metaOf(header),
    objectPath: objectPath(header.id),
    encryptedSize: stored.encryptedSize,
    partCount: stored.partCount,
    state: "active" as const,
    updatedAt: header.updatedAt,
    // seeded from createdAt so any later edit outranks the upload-time value
    fieldVersions: fieldVersions ?? Object.fromEntries(MUTABLE_FIELDS.map((f) => [f, created])),
  });
}

export function entryFromSidecar(sidecar: Sidecar): IndexEntry {
  const created = Date.parse(sidecar.facts.createdAt) || 0;
  return prune({
    ...factsOf(sidecar.facts),
    ...metaOf(sidecar.meta),
    objectPath: objectPath(sidecar.facts.id),
    encryptedSize: sidecar.encryptedSize,
    partCount: sidecar.partCount,
    state: "active" as const,
    updatedAt: sidecar.updatedAt,
    fieldVersions: { state: created, ...sidecar.fieldVersions },
  });
}

export function sidecarFromEntry(entry: IndexEntry): Sidecar {
  const fieldVersions: FieldVersions = {};
  for (const f of SIDECAR_FIELDS) {
    if (entry.fieldVersions[f] !== undefined) fieldVersions[f] = entry.fieldVersions[f];
  }
  return {
    version: 1,
    facts: prune(factsOf(entry)),
    meta: prune(metaOf(entry)),
    fieldVersions,
    encryptedSize: entry.encryptedSize,
    partCount: entry.partCount,
    updatedAt: entry.updatedAt,
  };
}

export function headerFromEntry(entry: IndexEntry): ObjectHeader {
  return prune({ version: 1 as const, ...factsOf(entry), ...metaOf(entry), updatedAt: entry.updatedAt });
}

export type MetaPatch = Partial<{
  name: string;
  ownerProfileIds: string[];
  category: string | undefined;
  tags: string[];
  note: string | undefined;
  issueDate: string | undefined;
  expiryDate: string | undefined;
  issuer: string | undefined;
  referenceNumber: string | undefined;
  temporary: { expiresAt: string } | undefined;
  reminders: number[] | undefined;
}>;

const PATCH_TO_FIELD: Record<keyof MetaPatch, MutableField> = {
  name: "name", ownerProfileIds: "ownerProfileIds", category: "category", tags: "tags", note: "note",
  issueDate: "document.issueDate", expiryDate: "document.expiryDate",
  issuer: "document.issuer", referenceNumber: "document.referenceNumber",
  temporary: "temporary", reminders: "reminders",
};

/** Returns a new entry with the patch applied and the touched fields' clocks bumped. */
export function applyPatch(entry: IndexEntry, patch: MetaPatch, now = new Date()): IndexEntry {
  const next: IndexEntry = structuredClone(entry);
  for (const key of Object.keys(patch) as Array<keyof MetaPatch>) {
    const field = PATCH_TO_FIELD[key];
    setField(next, field, patch[key]);
    next.fieldVersions[field] = nextVersion(entry.fieldVersions[field], now.getTime());
  }
  next.updatedAt = now.toISOString();
  return next;
}

export function setState(entry: IndexEntry, state: IndexEntry["state"], now = new Date()): IndexEntry {
  const next: IndexEntry = structuredClone(entry);
  setField(next, "state", { state, trashedAt: state === "trashed" ? now.toISOString() : undefined });
  next.fieldVersions.state = nextVersion(entry.fieldVersions.state, now.getTime());
  next.updatedAt = now.toISOString();
  return next;
}

export function upsertProfile(index: VaultIndex, profile: VaultProfile): VaultIndex {
  const profiles = index.profiles.filter((p) => p.id !== profile.id);
  profiles.push(profile);
  return { ...index, profiles };
}

export function activeProfiles(index: VaultIndex): VaultProfile[] {
  return index.profiles.filter((p) => !p.deletedAt);
}

export function activeCategories(index: VaultIndex): Category[] {
  return index.categories.filter((c) => !c.deletedAt);
}

export function getSetting<T>(index: VaultIndex, key: string, fallback: T): T {
  const s = index.settings[key];
  return s === undefined ? fallback : (s.value as T);
}

export function withSetting(index: VaultIndex, key: string, value: unknown, now = Date.now()): VaultIndex {
  return {
    ...index,
    settings: { ...index.settings, [key]: { value, v: nextVersion(index.settings[key]?.v, now) } },
  };
}

/** A temporary file past its time is gone as far as any view is concerned (§23.2). */
export function isExpiredTemporary(entry: IndexEntry, now = Date.now()): boolean {
  return !!entry.temporary && Date.parse(entry.temporary.expiresAt) <= now;
}

export function visibleEntries(index: VaultIndex, now = Date.now()): IndexEntry[] {
  return Object.values(index.entries).filter((e) => e.state === "active" && !isExpiredTemporary(e, now));
}
