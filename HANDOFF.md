# Handoff

State as of 19 Sep 2026. Read this, then `spec.md` (behaviour) and `ui_theme.md` (design + all copy). Both are gitignored, so they're only on the machine that has them.

## Where it stands

The vault works end to end against the `local-fs` store: setup, unlock, add, view, search, edit, trash, offline, backup, restore. It has never touched a real GitHub repo and no passkey has ever been enrolled. Those are the two real unknowns; everything else below is either tested or labelled.

`main` is clean and builds. 93 unit/integration tests, plus 12 that run over HTTP against a live server.

## Run it

```bash
npm install                      # postinstall copies PDF.js assets into public/pdfjs
cp .env.example .env             # local-fs needs only STORAGE_PROVIDER=local-fs
npm run dev
npm test
npm run build && npm start       # build is two passes, on purpose (see below)
```

Over-HTTP security suite (needs an EMPTY store, it runs setup):

```bash
STORAGE_PROVIDER=local-fs LOCAL_STORE_DIR=/tmp/fv-e2e npx next dev -p 3250
FV_E2E_BASE=http://localhost:3250 npx vitest run src/server/api.e2e.test.ts
```

In dev only, `window.__vault` is the worker RPC handle. `await __vault.unlockWithPassword("…")`, `__vault.addDocuments([...])`. It's dead code in production.

## How it moves

```
page (React)  ──RPC──▶  vault.worker  ──fetch──▶  /api/*  ──▶  StorageProvider
   no keys, ever         holds the VMK              ciphertext     github | local-fs
                         runs VaultEngine           + opaque ids
                         owns IndexedDB cache
```

- **`src/crypto`**: primitives and the three binary formats: object container `FVLT` (encrypted header inside, content padded to buckets, split into 4 MiB parts), sidecar `FVMD` (the editable label), index `FVIX` (fresh key per write).
- **`src/vault/engine.ts`** is the heart. Three invariants: objects before index, always; every index write is compare-and-swap and a lost race is *merged*, never overwritten; local edits apply first and push after, so offline isn't a mode, it's just a longer gap before the push.
- **`src/vault/merge.ts`** is a CRDT join (per-field LWW on a hybrid clock, tombstones win). Property-tested. If you touch it, the properties in `merge.test.ts` are the contract.
- **`src/client/session-core.ts`** runs inside the worker and is the only code that ever sees a key. The page gets state pushes and a typed RPC (`src/client/rpc.ts` is the allowlist).
- **`src/server/api.ts`** wraps every route: session → rate limit → role → CSRF → write-auth HMAC. Add a route by wrapping it in `api({...})`; don't hand-roll auth.

## Decisions I made without asking

`ui_theme.md` Appendix B lists open issues in the spec. I took the recommended option each time. **The owner hasn't confirmed any of these.**

| Issue | What's built |
|---|---|
| B-1 edits vs "header is authoritative" | Sidecar `objects/<id>.meta.vault`, carries its own wrapped file key so Repair reads a few KB per document |
| B-2 Shred | Dropped. It can't deliver what §7.6 promises while history is kept |
| B-3 delete precondition | Write-auth: `K_w = HKDF(VMK)`, server checks an HMAC on every mutating request |
| B-4 QR enrolment | Gone. Unlock with the password on the new phone, then add its fingerprint |
| B-5 server state | `server/registry.json` in the store. Sessions are stateless signed cookies, revoked by an epoch |
| B-6 Vercel body limit | Objects split into 4 MiB parts; `partCount` added to the container prefix |
| B-7 | UUIDv4 |
| B-8 recovery code | 8×4 Crockford, 155 bits + check symbol, two random groups to confirm |
| B-9 roles | Password session = member once an admin passkey exists (admin until then). Recovery-code session = admin. Members can enrol their own phone as a member |
| B-10 | Trash is index-only; the object never moves |
| B-11 | Metadata pads to **4 KB** (1 KB still leaked "long note"; a test caught it) |
| B-13/14 | Fixed Argon2id 64 MiB/t=3/p=1 via `hash-wasm` |
| B-15 CSP | No nonces. Static pages + per-route sha-256 hashes of Next's inline scripts, two-pass build |
| B-17 backups | Client-side only: folder mirror + `.fvault`. No cloud mirror |
| B-20 | Setup's test object is deleted after it passes |

Deviations not in Appendix B: object ids travel in a signed `x-fv-object` header, not the URL (hosts log URLs); plain `fetch` to GitHub instead of Octokit; `PUT` with client-made ids instead of `POST /api/objects` (idempotent retries); **all dates and times display in IST** regardless of device clock (`src/lib/format.ts`; never use local `Date` getters for display).

## Verified, and how

| What | How |
|---|---|
| Crypto, container, padding, recovery code, envelopes | unit tests |
| Merge | property tests: commutative, associative, idempotent, nothing lost except to a tombstone |
| Engine: CAS conflicts, orphans, rebuild with index deleted, trash/purge, offline queue replay | integration tests, memory provider |
| Backup mirror + verify, disaster recovery | tests, and once for real in Chrome: `.fvault` → empty deployment → recovery code only → store byte-identical |
| GitHub adapter | tests against `src/storage/fake-github.ts` (**my model of GitHub, not GitHub**) |
| API auth, CSRF, write-auth, CAS, delete precondition, rate limiting | 12 tests over real HTTP; no object ids in request logs |
| Setup, lock, add (EXIF stripped from the *stored* bytes), document, viewer (image + PDF), search, trash, people, categories, settings | walked in Chrome at phone width |
| Offline | production build, network off, hard reload, unlock, open a PDF |
| CSP | production build, zero violations, no `unsafe-inline`/`unsafe-eval` |
| Layout | 1280 px sidebar layout; 200% text on every route, no sideways scroll |
| No plaintext at rest | grepped the store, IndexedDB, Cache Storage and the export |

## Not verified

- **Real GitHub.** `.env` has `GITHUB_PAT` but no `GITHUB_OWNER` / `GITHUB_REPOSITORY`. Loading the PAT into a shell was blocked by the agent's permission classifier and I didn't route around it. Likeliest surprises: read-after-write lag on the contents API (safe: a stale read just fails the next CAS), error codes on an empty repo, rate limits during Repair (~2 calls per document).
- **Every passkey path.** No platform authenticator on the dev machine. Enrol, unlock, PRF-at-create vs PRF-needs-second-prompt, offline passkey unlock, `resumeSession` are all untested. Needs a real Android phone and an iPhone. The no-PRF fallback notice *is* verified.
- **Automatic backups and the folder backup UI.** The native folder picker can't be automated. The mirror logic underneath is tested.
- **Share target** (Android share sheet → service worker → `/add`). Needs an installed PWA on Android.
- Camera capture row, Web Share, pinch zoom, `prefers-reduced-motion` in a browser, tablet width, iOS anything.

## Not built

1. **One commit per upload on GitHub (B-16).** Today an upload is part(s) → index → sidecar, each its own commit, ~6 API calls apiece. `GitHubStorageProvider.commit(changes, preconditions)` already does multi-file commits internally (used by `deleteMany`). Sketch: stage blobs (`POST /git/blobs` needs no commit) via `PUT /api/objects/part` with a stage flag returning the blob sha, then `POST /api/vault/commit { files: [{path, token}], index, ifMatch }`. Keep the object-first path for providers without staging. The fake GitHub makes this testable.
2. **Cloud backup mirror** (Drive etc.), server-side, per B-17.
3. **Key rotation**, QR enrolment, PDF compression, thumbnails, multiple vaults (spec P2).
4. **Rate limits are in-memory.** Real on one Node process; per-instance on serverless. Swap the map in `src/server/rate-limit.ts` for a KV.
5. **Recovery drill** (§20.4, the 180-day "can you still find the code?" prompt).
6. Removing a device doesn't rotate the vault key (rotation is P2), and the copy says so rather than pretending.

## Do these next, in this order

1. Add `GITHUB_OWNER`, `GITHUB_REPOSITORY` (private, empty repo) and a 32+ char `SESSION_SECRET` to `.env`. Run setup. Then clone the store repo and grep it and `git log` for anything readable (§40.2).
2. Deploy somewhere with HTTPS on the domain you intend to keep forever (passkeys are origin-bound), and do the passkey pass on real phones.
3. Get the owner's yes/no on the Appendix B decisions above, B-9 especially: it decides what parents can and can't do.
4. Then B-16, because on real GitHub latency an upload will feel slow.

## Things that will bite you

- **The build runs twice** (`scripts/build.mjs`): pass one discovers each page's inline scripts, pass two pins their hashes into a per-route CSP, and it fails if the passes differ. Any page that becomes dynamic loses its hashes and will render blank in production. Keep pages static. `generateBuildId` is fixed for the same reason.
- **Don't bundle the PDF.js worker.** Production tree-shaking removed its start-up side effect and it sat there alive and silent. It's served as the stock file from `/pdfjs/` (copied by `scripts/copy-pdfjs.mjs`).
- **Match storage errors by name** (`isNotFound`, `isPreconditionFailed`), never `instanceof`. The provider is cached on `globalThis` and outlives the module that made it; `instanceof` turned a 404 into a 500 and wedged sync.
- **`sync()` snapshots must never be written back over `engine.index`.** That was a real lost-update bug; the `revision` counter is the guard.
- The service worker installs from `public/precache.json`, written between build passes. A lazily loaded chunk that isn't in it won't exist offline.
- A deleted page leaves a stale `.next/dev/types` that fails `npm run build`. `rm -rf .next`.
- Parallel dev servers: `FV_DIST_DIR=.next-x npx next dev -p 33xx`. `next start` re-execs as `next-server`; kill by PID from `ss -ltnp`. In zsh, never name a variable `path`.
- HMR while navigating can wedge the Next router in dev. Not reproducible in a production build.

## Invariants. Break one and it's a security bug

- Nothing the server receives can decrypt anything. No key in env, ever.
- Plaintext never rests anywhere: not IndexedDB, not Cache Storage, not the service worker (shared files wait in its memory only).
- No filename, person, category or object id in a URL, a log line, or a commit message.
- Every preview URL goes through `createPreviewUrl`, so lock can revoke it without trusting component cleanup.
- The lock screen shows nothing: no counts, no names. The document title is always "Family Vault".
- UI copy: deleted means *removed from your vault*, never erased; nothing implies one family member can't read another's documents; no crypto words outside Settings → Technical details.
