import { createHash } from "node:crypto";

/**
 * An in-memory stand-in for the slice of GitHub's REST API the adapter uses,
 * faithful where it matters: content-addressed blobs, trees built on a base
 * tree, commits with parents, and a ref that only moves fast-forward unless
 * forced. An empty repository refuses the Git Data API the way the real one does.
 *
 * Test-only. It exists because the adapter's whole job is getting compare-and-swap
 * right over an API that doesn't offer one directly, and that deserves tests that
 * don't need a token.
 */
interface Commit { tree: string; parents: string[]; message: string }

/** git's empty tree. Every repository "has" it and GitHub's API serves none of them: asking for it is a 404. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class FakeGitHub {
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>(); // tree sha -> path -> blob sha
  commits = new Map<string, Commit>();
  head: string | null = null;
  isPrivate = true;
  canPush = true;
  requests: Array<{ method: string; path: string }> = [];
  /** runs just before a ref update is applied: the place to make someone else win the race */
  beforeRefUpdate: (() => void | Promise<void>) | null = null;
  forcePushes = 0;

  private sha(kind: string, body: string | Buffer): string {
    return createHash("sha1").update(kind).update(body).digest("hex");
  }

  private json(status: number, data: unknown): Response {
    return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }

  get messages(): string[] {
    const out: string[] = [];
    for (let c = this.head; c; c = this.commits.get(c)!.parents[0] ?? null) out.push(this.commits.get(c)!.message);
    return out.reverse();
  }

  files(): Map<string, string> {
    return (this.head && this.trees.get(this.commits.get(this.head)!.tree)) || new Map();
  }

  /**
   * The state a repository is in after its files are deleted, or after
   * `git commit --allow-empty` on a new one: a branch, a commit, and no files.
   * Not the same as a repository with no commits at all.
   */
  seedEmptyCommit(message = "Initial empty commit"): void {
    const sha = this.sha("commit", `${EMPTY_TREE}:${message}`);
    this.commits.set(sha, { tree: EMPTY_TREE, parents: [], message });
    this.head = sha;
  }

  /** what another writer does: commit straight to the branch */
  commitDirectly(path: string, data: Buffer, message = "someone else"): void {
    const blob = this.sha("blob", data);
    this.blobs.set(blob, data);
    const tree = new Map(this.files());
    tree.set(path, blob);
    this.addCommit(tree, message);
  }

  private addCommit(tree: Map<string, string>, message: string): string {
    const treeSha = this.sha("tree", JSON.stringify([...tree].sort()));
    this.trees.set(treeSha, tree);
    const sha = this.sha("commit", `${treeSha}:${this.head}:${message}:${this.commits.size}`);
    this.commits.set(sha, { tree: treeSha, parents: this.head ? [this.head] : [], message });
    this.head = sha;
    return sha;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const m = /^\/repos\/[^/]+\/[^/]+(\/.*)?$/.exec(url.pathname);
    if (!m) return this.json(404, {});
    const path = decodeURIComponent(m[1] ?? "");
    this.requests.push({ method, path });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const accept = new Headers(init.headers).get("accept") ?? "";

    if (path === "" && method === "GET") return this.json(200, { private: this.isPrivate, permissions: { push: this.canPush } });

    if (path.startsWith("/contents/")) {
      const file = path.slice("/contents/".length);
      if (method === "PUT") {
        // the one write that works on an empty repository
        if (this.files().has(file)) return this.json(422, { message: "sha wasn't supplied" });
        const data = Buffer.from(body.content, "base64");
        const blob = this.sha("blob", data);
        this.blobs.set(blob, data);
        const tree = new Map(this.files());
        tree.set(file, blob);
        this.addCommit(tree, body.message);
        return this.json(201, {});
      }
      const ref = url.searchParams.get("ref") ?? "";
      const commit = this.commits.get(ref) ?? (this.head ? this.commits.get(this.head) : undefined);
      const blob = commit ? this.trees.get(commit.tree)?.get(file) : undefined;
      if (!blob) return this.json(404, { message: "Not Found" });
      const data = this.blobs.get(blob)!;
      const big = data.length > 1_000_000;
      return this.json(200, { type: "file", sha: blob, size: data.length, encoding: big ? "none" : "base64", content: big ? "" : data.toString("base64") });
    }

    if (path.startsWith("/commits/") && method === "GET") {
      if (!this.head) return this.json(409, { message: "Git Repository is empty." });
      return this.json(200, { sha: this.head, commit: { tree: { sha: this.commits.get(this.head)!.tree } } });
    }

    // everything below is the Git Data API, which an empty repository refuses
    if (!this.head && path.startsWith("/git/")) return this.json(409, { message: "Git Repository is empty." });

    if (path === "/git/blobs" && method === "POST") {
      const data = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
      const sha = this.sha("blob", data);
      this.blobs.set(sha, data);
      return this.json(201, { sha });
    }
    if (path.startsWith("/git/blobs/") && method === "GET") {
      const data = this.blobs.get(path.slice("/git/blobs/".length));
      if (!data) return this.json(404, {});
      if (accept.includes("raw")) return new Response(new Uint8Array(data), { status: 200 });
      return this.json(200, { content: data.toString("base64"), encoding: "base64" });
    }
    if (path.startsWith("/git/ref/heads/") && method === "GET") return this.json(200, { object: { sha: this.head } });
    if (path.startsWith("/git/commits/") && method === "GET") {
      const c = this.commits.get(path.slice("/git/commits/".length));
      return c ? this.json(200, { tree: { sha: c.tree } }) : this.json(404, {});
    }
    if (path === "/git/trees" && method === "POST") {
      // no base_tree means "this is the whole tree"; the empty tree is not an object you can build on
      const base = body.base_tree === undefined ? new Map<string, string>() : this.trees.get(body.base_tree);
      if (!base) return this.json(404, { message: "Not Found" });
      const tree = new Map(base);
      for (const e of body.tree as Array<{ path: string; sha: string | null }>) {
        if (e.sha === null) {
          if (!tree.has(e.path)) return this.json(422, { message: "GitRPC::BadObjectState" }); // deleting what isn't there
          tree.delete(e.path);
        } else {
          if (!this.blobs.has(e.sha)) return this.json(422, { message: "tree.sha is not a valid blob" });
          tree.set(e.path, e.sha);
        }
      }
      const sha = this.sha("tree", JSON.stringify([...tree].sort()));
      this.trees.set(sha, tree);
      return this.json(201, { sha });
    }
    if (path === "/git/commits" && method === "POST") {
      const sha = this.sha("commit", `${body.tree}:${body.parents.join()}:${body.message}:${this.commits.size}`);
      this.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return this.json(201, { sha });
    }
    if (path.startsWith("/git/refs/heads/") && method === "PATCH") {
      await this.beforeRefUpdate?.();
      const commit = this.commits.get(body.sha);
      if (!commit) return this.json(422, {});
      if (body.force) this.forcePushes++;
      else if (commit.parents[0] !== this.head) return this.json(422, { message: "Update is not a fast forward" });
      this.head = body.sha;
      return this.json(200, { object: { sha: this.head } });
    }
    if (path.startsWith("/git/trees/") && method === "GET") {
      const wanted = path.slice("/git/trees/".length);
      const named = this.trees.get(wanted);
      // a branch name resolves to its head's tree, and an empty tree is a 404 either way
      const tree = named ?? (this.commits.has(wanted) || wanted.length === 40 ? undefined : this.trees.get(this.commits.get(this.head!)!.tree));
      if (!tree) return this.json(404, { message: "Not Found" });
      return this.json(200, { tree: [...tree].map(([p, sha]) => ({ path: p, type: "blob", sha, size: this.blobs.get(sha)!.length })), truncated: false });
    }
    return this.json(404, { message: `fake: unhandled ${method} ${path}` });
  };
}
