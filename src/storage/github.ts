import {
  NotFoundError, PreconditionFailedError, type StorageProvider, type StoredItem,
  StorageUnavailableError, assertAllowedPath,
} from "./provider";

type Bytes = Uint8Array<ArrayBuffer>;

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

interface Change {
  path: string;
  /** null deletes the path */
  data: Bytes | null;
}

interface Precondition {
  path: string;
  ifMatch?: string;
  ifNoneMatch?: "*";
}

const API = "https://api.github.com";
const MAX_ATTEMPTS = 6;

/**
 * §7.7. A private repository used as a blob store, written through the Git Data
 * API: blob → tree → commit on the current head → move the ref *without force*.
 *
 * The ref update is the compare-and-swap. If anyone else committed since we read
 * the head, GitHub refuses the non-fast-forward and we start over from the new
 * head, re-checking the caller's precondition against it. History is ordinary
 * and is kept — it is free undelete (§7.3).
 *
 * A file's version token is its git blob sha.
 *
 * Commit messages never carry a filename, and object ids aren't names (§7.3).
 */
export class GitHubStorageProvider implements StorageProvider {
  id = "github";
  name = "GitHub";
  capabilities = { conditionalWrite: true, versioning: true, delete: true, list: true };

  /** one writer at a time per process, so we don't race ourselves into retries */
  private queue: Promise<unknown> = Promise.resolve();
  private verified = false;

  constructor(
    private cfg: GitHubConfig,
    /** swapped for an in-memory GitHub in tests */
    private fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {
    // owner and repo come from server env only; nothing a client sends can retarget the store
    for (const v of [cfg.owner, cfg.repo, cfg.branch]) {
      if (!/^[A-Za-z0-9._-]+$/.test(v)) throw new Error("invalid GitHub repository configuration");
    }
  }

  get location(): string {
    return `${this.cfg.owner}/${this.cfg.repo}`;
  }

  // ───────────────────────── http ─────────────────────────

  private async request(method: string, path: string, body?: unknown, accept = "application/vnd.github+json") {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}/repos/${this.cfg.owner}/${this.cfg.repo}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          accept,
          "x-github-api-version": "2022-11-28",
          "user-agent": "family-vault",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch {
      throw new StorageUnavailableError("could not reach GitHub");
    }
    if (res.status === 401) throw new StorageUnavailableError("GitHub rejected the access token");
    if (res.status === 403 || res.status === 429) {
      const limited = res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after");
      throw new StorageUnavailableError(limited ? "GitHub rate limit reached" : "the access token can't write to this repository");
    }
    if (res.status >= 500) throw new StorageUnavailableError("GitHub is having trouble");
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.request(method, path, body);
    const data = (res.status === 204 ? null : await res.json().catch(() => null)) as T;
    return { status: res.status, data };
  }

  // ───────────────────────── lifecycle ─────────────────────────

  async connect(): Promise<void> {
    if (this.verified) return;
    const { status, data } = await this.json<{ private?: boolean; permissions?: { push?: boolean } }>("GET", "");
    if (status === 404) throw new StorageUnavailableError("repository not found, or the token can't see it");
    if (status !== 200) throw new StorageUnavailableError();
    // Privacy isn't the security control here — encryption is — but a public
    // repo used as file storage is an acceptable-use problem, and an invitation.
    if (data.private !== true) throw new StorageUnavailableError("the storage repository must be private");
    if (data.permissions && data.permissions.push === false) {
      throw new StorageUnavailableError("the access token can't write to this repository");
    }
    this.verified = true;
  }

  async isConnected(): Promise<boolean> {
    return this.connect().then(() => true, () => false);
  }

  async disconnect(): Promise<void> {
    this.verified = false;
  }

  // ───────────────────────── reads ─────────────────────────

  private encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  /** blob sha of `path` at `ref`, or null */
  private async blobSha(path: string, ref: string): Promise<string | null> {
    const { status, data } = await this.json<{ sha?: string; type?: string }>(
      "GET", `/contents/${this.encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (status === 404) return null;
    if (status !== 200 || !data?.sha || data.type !== "file") throw new StorageUnavailableError();
    return data.sha;
  }

  async get(path: string): Promise<{ data: Bytes; version: string }> {
    assertAllowedPath(path);
    const { status, data } = await this.json<{ sha: string; size: number; content?: string; encoding?: string; type?: string }>(
      "GET", `/contents/${this.encodePath(path)}?ref=${encodeURIComponent(this.cfg.branch)}`,
    );
    if (status === 404) throw new NotFoundError();
    if (status !== 200 || data?.type !== "file") throw new StorageUnavailableError();

    // The contents API inlines up to 1 MB; past that, go to the blob (§7.7).
    if (data.encoding === "base64" && data.content && data.size <= 1_000_000) {
      return { data: fromBase64(data.content), version: data.sha };
    }
    const res = await this.request("GET", `/git/blobs/${data.sha}`, undefined, "application/vnd.github.raw+json");
    if (res.status !== 200) throw new StorageUnavailableError();
    return { data: new Uint8Array(await res.arrayBuffer()) as Bytes, version: data.sha };
  }

  async list(prefix = ""): Promise<StoredItem[]> {
    const { status, data } = await this.json<{ tree?: Array<{ path: string; type: string; size?: number; sha: string }> }>(
      "GET", `/git/trees/${encodeURIComponent(this.cfg.branch)}?recursive=1`,
    );
    if (status === 404 || status === 409) return []; // empty repository
    if (status !== 200 || !data?.tree) throw new StorageUnavailableError();
    return data.tree
      .filter((e) => e.type === "blob" && e.path.startsWith(prefix))
      .map((e) => ({ path: e.path, size: e.size ?? 0, version: e.sha }));
  }

  // ───────────────────────── writes ─────────────────────────

  async put(path: string, data: Bytes, opts?: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<{ version: string }> {
    assertAllowedPath(path);
    const shas = await this.commit(
      [{ path, data }],
      opts?.ifMatch !== undefined || opts?.ifNoneMatch ? [{ path, ...opts }] : [],
      path === "index.vault" ? "vault: update index" : path === "vault.json" ? "vault: update config" : "vault: add object",
    );
    return { version: shas.get(path)! };
  }

  async delete(path: string, opts?: { ifMatch?: string }): Promise<void> {
    assertAllowedPath(path);
    await this.commit([{ path, data: null }], opts?.ifMatch !== undefined ? [{ path, ifMatch: opts.ifMatch }] : [], "vault: remove object");
  }

  /** Every part and the sidecar of one document, in one commit. */
  async deleteMany(paths: string[]): Promise<void> {
    paths.forEach(assertAllowedPath);
    if (paths.length) await this.commit(paths.map((path) => ({ path, data: null })), [], "vault: remove object");
  }

  private commit(changes: Change[], preconditions: Precondition[], message: string): Promise<Map<string, string>> {
    const run = () => this.commitNow(changes, preconditions, message);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async commitNow(changes: Change[], preconditions: Precondition[], message: string): Promise<Map<string, string>> {
    // Blobs are content-addressed and independent of any commit: upload once, reuse across retries.
    const blobs = new Map<string, string>();
    for (const c of changes) {
      if (!c.data) continue;
      const { status, data } = await this.json<{ sha: string }>("POST", "/git/blobs", { content: toBase64(c.data), encoding: "base64" });
      if (status === 409 || status === 404) {
        // an empty repository has no object database to write to yet
        await this.bootstrap();
        return this.commitNow(changes, preconditions, message);
      }
      if (status !== 201) throw new StorageUnavailableError();
      blobs.set(c.path, data.sha);
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const head = await this.json<{ object: { sha: string } }>("GET", `/git/ref/heads/${encodeURIComponent(this.cfg.branch)}`);
      if (head.status === 404 || head.status === 409) {
        await this.bootstrap();
        continue;
      }
      if (head.status !== 200) throw new StorageUnavailableError();
      const headSha = head.data.object.sha;

      for (const p of preconditions) {
        const current = await this.blobSha(p.path, headSha);
        if (p.ifNoneMatch === "*" && current) throw new PreconditionFailedError();
        if (p.ifMatch !== undefined && current !== p.ifMatch) throw new PreconditionFailedError();
      }

      // deleting something that isn't there would make the tree call fail; drop those
      const live: Change[] = [];
      for (const c of changes) {
        if (c.data || (await this.blobSha(c.path, headSha))) live.push(c);
      }
      if (live.length === 0) return blobs;

      const parent = await this.json<{ tree: { sha: string } }>("GET", `/git/commits/${headSha}`);
      if (parent.status !== 200) throw new StorageUnavailableError();

      const tree = await this.json<{ sha: string }>("POST", "/git/trees", {
        base_tree: parent.data.tree.sha,
        tree: live.map((c) => ({ path: c.path, mode: "100644", type: "blob", sha: c.data ? blobs.get(c.path) : null })),
      });
      if (tree.status !== 201) throw new StorageUnavailableError();

      const commit = await this.json<{ sha: string }>("POST", "/git/commits", {
        message, tree: tree.data.sha, parents: [headSha],
      });
      if (commit.status !== 201) throw new StorageUnavailableError();

      const moved = await this.json("PATCH", `/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`, {
        sha: commit.data.sha, force: false,
      });
      if (moved.status === 200) return blobs;
      if (moved.status !== 422 && moved.status !== 409) throw new StorageUnavailableError();
      // not a fast-forward: someone else committed first. Go again from their head.
      await new Promise((r) => setTimeout(r, 80 * (attempt + 1) + Math.random() * 120));
    }
    throw new PreconditionFailedError();
  }

  /** The Git Data API can't write to a repository with no commits. The contents API can. */
  private async bootstrap(): Promise<void> {
    const { status } = await this.json("PUT", "/contents/README.md", {
      message: "vault: initialise store",
      branch: this.cfg.branch,
      content: Buffer.from("Encrypted Family Vault store. Nothing in here is readable without the family's keys.\n").toString("base64"),
    });
    // 422: somebody (or a concurrent request) got there first, which is fine
    if (status !== 201 && status !== 200 && status !== 422 && status !== 409) throw new StorageUnavailableError();
  }
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

function fromBase64(text: string): Bytes {
  const buf = Buffer.from(text, "base64");
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) as Bytes;
}
