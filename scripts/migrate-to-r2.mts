/**
 * One-off: copy the store from the GitHub repository into an R2 bucket.
 *
 *   npx tsx scripts/migrate-to-r2.mts            # dry run, says what it would do
 *   npx tsx scripts/migrate-to-r2.mts --apply    # actually copies
 *
 * Reads GITHUB_* and R2_* from the environment (or ./.env). Both providers are
 * the real ones the app uses, so this exercises the same code paths the tests do.
 *
 * This is deliberately NOT vault/backup.ts's mirrorTo(): that seals a manifest
 * and opens the index to cross-check them, which needs the vault master key.
 * The server has never held that key and this script runs server-side (§31), so
 * it does the one verification that's available without it — read every file
 * back from the destination and compare sha-256 against the source bytes. It
 * copies ciphertext it cannot read and proves the bytes arrived intact.
 *
 * Safe to re-run. A file already at the destination with a matching hash is
 * skipped, so an interrupted run resumes where it stopped.
 */
import { createHash } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { GitHubStorageProvider } from "../src/storage/github";
import { isAllowedPath, isNotFound } from "../src/storage/provider";
import { R2StorageProvider } from "../src/storage/r2";

// On a network with no IPv6 route, Node still resolves Cloudflare's AAAA records
// some of the time and the connection dies with ENETUNREACH. Nothing about the
// migration is wrong when that happens, it just stops. Prefer A records.
setDefaultResultOrder("ipv4first");

try {
  process.loadEnvFile();
} catch {
  // no ./.env, so the variables had better already be in the environment
}

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 4;

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function required(...names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const n of names) {
    const v = process.env[n];
    if (v) out[n] = v;
    else missing.push(n);
  }
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  return out;
}

/**
 * Both ends drop a connection now and then — GitHub truncates a body ("terminated"),
 * a stray AAAA lookup gets ENETUNREACH. Neither means the file can't be copied, so
 * don't let one abandon it.
 */
async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new Error(`${what}: ${(last as Error).message}`, { cause: last });
}

/** Runs `worker` over `items`, a few at a time, preserving nothing but the side effects. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

const env = required(
  "GITHUB_OWNER", "GITHUB_REPOSITORY",
  "R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
);
const token = process.env.GITHUB_PAT ?? process.env.GITHUB_TOKEN;
if (!token) {
  console.error("Missing environment variables: GITHUB_PAT");
  process.exit(1);
}

const source = new GitHubStorageProvider({
  token,
  owner: env.GITHUB_OWNER,
  repo: env.GITHUB_REPOSITORY,
  branch: process.env.GITHUB_BRANCH ?? "main",
});
const dest = new R2StorageProvider({
  accountId: env.R2_ACCOUNT_ID,
  bucket: env.R2_BUCKET,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
});

console.log(`source  ${env.GITHUB_OWNER}/${env.GITHUB_REPOSITORY} (${process.env.GITHUB_BRANCH ?? "main"})`);
console.log(`dest    r2://${env.R2_BUCKET}`);
console.log(APPLY ? "mode    apply\n" : "mode    dry run — nothing will be written\n");

await source.connect();
await dest.connect();

const listing = await source.list();
// README.md and anything else a human put in the repo is not part of the store.
const files = listing.filter((f) => isAllowedPath(f.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
const ignored = listing.filter((f) => !isAllowedPath(f.path));

const already = new Map((await dest.list()).map((f) => [f.path, f]));

console.log(`${files.length} store files at the source (${ignored.length} other files ignored)`);
if (!files.some((f) => f.path === "server/registry.json")) {
  console.log("  ! no server/registry.json at the source — without it nobody can sign in to the new store");
}

let copied = 0, skipped = 0, failed = 0;
const problems: string[] = [];

await pool(files, CONCURRENCY, async (file) => {
  let bytes: Uint8Array;
  try {
    bytes = (await retry("read", () => source.get(file.path))).data;
  } catch (e) {
    failed++;
    problems.push(`${file.path}: could not read from GitHub (${isNotFound(e) ? "not found" : (e as Error).message})`);
    return;
  }
  const want = sha256(bytes);

  // Already there and identical? Nothing to do. This is what makes a re-run cheap.
  if (already.has(file.path)) {
    try {
      if (sha256((await dest.get(file.path)).data) === want) {
        skipped++;
        return;
      }
    } catch {
      // unreadable at the destination, so fall through and rewrite it
    }
  }

  if (!APPLY) {
    console.log(`  would copy  ${file.path}  (${bytes.length} bytes)`);
    copied++;
    return;
  }

  let back: string;
  try {
    await retry("write", () => dest.put(file.path, bytes as Uint8Array<ArrayBuffer>));
    // "HTTP 200 is not a backup" (§27.5): read it back and hash it.
    back = sha256((await retry("read back", () => dest.get(file.path))).data);
  } catch (e) {
    failed++;
    problems.push(`${file.path}: ${(e as Error).message}`);
    return;
  }
  if (back !== want) {
    failed++;
    problems.push(`${file.path}: copied, but the bytes at the destination don't match`);
    return;
  }
  copied++;
  if (copied % 25 === 0) console.log(`  ${copied} copied…`);
});

// Files at the destination that the source doesn't have. Left alone on purpose:
// deleting from a store is the app's job, not a migration's.
const extra = [...already.keys()].filter((p) => !files.some((f) => f.path === p));

console.log(`\n${APPLY ? "copied" : "would copy"}  ${copied}`);
console.log(`skipped (already identical)  ${skipped}`);
if (extra.length) console.log(`at the destination but not the source  ${extra.length}: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? "…" : ""}`);
if (problems.length) {
  console.log(`\n${failed} problem${failed === 1 ? "" : "s"}:`);
  for (const p of problems) console.log(`  ${p}`);
}

if (APPLY && !failed) {
  console.log("\nEvery file was read back from R2 and matched. Set STORAGE_PROVIDER=r2 when you're ready.");
}
process.exit(failed ? 1 : 0);
