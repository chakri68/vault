/**
 * §7.1. One interface for primary storage and for backups. No implementation
 * contains decryption logic and none ever sees a plaintext name: every provider
 * receives the same bytes in the same layout, which is what lets a backup taken
 * to one provider restore through another.
 */
export interface StorageProvider {
  id: string;
  name: string;
  capabilities: {
    /** compare-and-swap on a version token. Required of a primary store. */
    conditionalWrite: boolean;
    /** retains prior versions natively */
    versioning: boolean;
    delete: boolean;
    list: boolean;
  };

  connect(): Promise<void>;
  isConnected(): Promise<boolean>;
  disconnect(): Promise<void>;

  get(path: string): Promise<{ data: Uint8Array<ArrayBuffer>; version: string }>;

  put(
    path: string,
    data: Uint8Array<ArrayBuffer>,
    opts?: {
      /** write only if the current version matches. "*" is not accepted here. */
      ifMatch?: string;
      /** write only if the path doesn't exist yet */
      ifNoneMatch?: "*";
      contentType?: string;
    },
  ): Promise<{ version: string }>;

  delete(path: string, opts?: { ifMatch?: string }): Promise<void>;

  list(prefix?: string): Promise<StoredItem[]>;
}

export interface StoredItem {
  path: string;
  size: number;
  version: string;
  modifiedAt?: string;
}

export class NotFoundError extends Error {
  constructor(path = "") {
    super(`not found${path ? `: ${path}` : ""}`);
    this.name = "NotFoundError";
  }
}

/** A failed compare-and-swap. Callers refetch, merge and retry (§9.2). */
export class PreconditionFailedError extends Error {
  constructor() {
    super("precondition failed");
    this.name = "PreconditionFailedError";
  }
}

export class StorageUnavailableError extends Error {
  constructor(message = "storage unavailable") {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

/**
 * Match by name, not by class. A provider instance can outlive the module that
 * made it (dev reloads, or two bundles each with their own copy of this file),
 * and then `instanceof` quietly says no — turning a plain 404 into a 500.
 */
const named = (e: unknown, name: string) => !!e && typeof e === "object" && (e as { name?: unknown }).name === name;
export const isNotFound = (e: unknown): e is NotFoundError => named(e, "NotFoundError");
export const isPreconditionFailed = (e: unknown): e is PreconditionFailedError => named(e, "PreconditionFailedError");
export const isStorageUnavailable = (e: unknown): e is StorageUnavailableError => named(e, "StorageUnavailableError");

/**
 * The only paths a provider is ever asked for. Anything else — traversal, an
 * absolute path, a stray extension — is rejected before it reaches the store (§6.6).
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ALLOWED = [
  /^vault\.json$/,
  /^index\.vault$/,
  /^backup-manifest\.vault$/,
  /^server\/registry\.json$/,
  new RegExp(`^objects/${UUID}\\.vault$`),
  new RegExp(`^objects/${UUID}\\.p([1-9]|[1-5][0-9]|6[0-3])\\.vault$`),
  new RegExp(`^objects/${UUID}\\.meta\\.vault$`),
];

export function isAllowedPath(path: string): boolean {
  return ALLOWED.some((re) => re.test(path));
}

export function assertAllowedPath(path: string): void {
  if (!isAllowedPath(path)) throw new Error("path not allowed");
}

const OBJECT_FILE = new RegExp(`^objects/(${UUID})(?:\\.(p\\d+|meta))?\\.vault$`);

/** "objects/<id>.p2.vault" → { id, kind: "part", part: 2 } */
export function parseObjectPath(
  path: string,
): { id: string; kind: "part"; part: number } | { id: string; kind: "meta" } | null {
  const m = OBJECT_FILE.exec(path);
  if (!m) return null;
  if (m[2] === "meta") return { id: m[1], kind: "meta" };
  return { id: m[1], kind: "part", part: m[2] ? Number(m[2].slice(1)) : 0 };
}
