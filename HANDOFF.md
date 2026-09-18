# Handoff

State as of 19 Sep 2026. Read this, then `spec.md` (behaviour) and `ui_theme.md` (design + all copy). Both are gitignored, so they're only on the machine that has them.

## Where it stands

The vault works end to end, against `local-fs` and against a real private GitHub repo: setup, unlock, add, view, search, edit, trash, offline, backup, restore, Repair. No passkey has ever been enrolled (no authenticator on the dev machine). That's the one real unknown left; everything else below is either tested or labelled.

`main` is clean and builds. 96 unit/integration tests, plus 13 that run over HTTP against a live server.

The store repo (`chakri68/vault-storage`) has been emptied by the owner and is ready for the family's real setup, which should happen **on the production domain, `vault.chakri.me`**, not on localhost: passkeys enrolled during setup bind to the origin they were made on. The test vault's ciphertext is still in that repo's git history, which is harmless (it's ciphertext, and its keys are gone).

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
| B-17 backups | Client-side only: folder mirror + `.zip`. No cloud mirror |
| B-20 | Setup's test object is deleted after it passes |

Deviations not in Appendix B: object ids travel in a signed `x-fv-object` header, not the URL (hosts log URLs); plain `fetch` to GitHub instead of Octokit; `PUT` with client-made ids instead of `POST /api/objects` (idempotent retries); **all dates and times display in IST** regardless of device clock (`src/lib/format.ts`; never use local `Date` getters for display).

## Verified, and how

| What | How |
|---|---|
| Crypto, container, padding, recovery code, envelopes | unit tests |
| Merge | property tests: commutative, associative, idempotent, nothing lost except to a tombstone |
| Engine: CAS conflicts, orphans, rebuild with index deleted, trash/purge, offline queue replay | integration tests, memory provider |
| Backup mirror + verify, disaster recovery | tests, and once for real in Chrome: `.zip` → empty deployment → recovery code only → store byte-identical |
| GitHub adapter | tests against `src/storage/fake-github.ts`, **and** a real private repo: empty-repo bootstrap, setup, the round-trip self test, uploads, edits, a second device, wrong password, Repair |
| Nothing readable in the real store | pulled all 34 blobs and the commit log via `gh`: no names, numbers, tags or MIME types anywhere; filenames are `objects/<uuid>.vault`; commit messages are five generic strings |
| API auth, CSRF, write-auth, CAS, delete precondition, rate limiting | 12 tests over real HTTP; no object ids in request logs |
| Setup, lock, add (EXIF stripped from the *stored* bytes), document, viewer (image + PDF), search, trash, people, categories, settings | walked in Chrome at phone width |
| Offline | production build, network off, hard reload, unlock, open a PDF |
| CSP | production build, zero violations, no `unsafe-inline`/`unsafe-eval` |
| Layout | 1280 px sidebar layout; 200% text on every route, no sideways scroll |
| No plaintext at rest | grepped the store, IndexedDB, Cache Storage and the export |

## Not verified

- **GitHub at scale and under contention.** Verified with 15 documents and one writer at a time. Not yet seen for real: two devices racing (covered against the fake only), a vault of hundreds, GitHub's secondary rate limits during a big Repair or backup, and any of it from a serverless host rather than one long-lived Node process.
- **Every passkey path.** No platform authenticator on the dev machine. Enrol, unlock, PRF-at-create vs PRF-needs-second-prompt, offline passkey unlock, `resumeSession` are all untested. Needs a real Android phone and an iPhone. The no-PRF fallback notice *is* verified.
- **Automatic backups and the folder backup UI.** The native folder picker can't be automated. The mirror logic underneath is tested.
- **Share target** (Android share sheet → service worker → `/add`). Needs an installed PWA on Android.
- Camera capture row, Web Share, pinch zoom, `prefers-reduced-motion` in a browser, tablet width, iOS anything.

## What GitHub actually costs

About **one second per API call** from India, and that number drives everything. Measured on the real repo:

| | before | now |
|---|---|---|
| upload 1 document | 15.3 s | 7.6 s |
| upload 8 documents | ~80 s (extrapolated) | 12.3 s |
| Repair, 15 documents | 17.5 s | 9.1 s |
| unlock, device already has the list | 2.2 s | 0.3–0.5 s |
| open one document (not yet on the device) | | 1.4 s |

Unlock doesn't wait on the store any more: a device with a cached index opens from it at once and merges the fresh one in behind the scenes (`refreshInBackground`). Only a device that has never seen the vault waits. Document ciphertext was always fetched in the background, now three at a time.

What got the rest there: blobs staged in parallel (`PUT /api/vault/stage`, no commit needed) then **one atomic commit** for parts + labels + index (`POST /api/vault/commit`, B-16); 5 sequential calls per commit instead of ~7; `registry.json` and `vault.json` cached server-side (they were a GitHub read on nearly every request); Repair reads labels eight at a time. An edit is still two commits (index, then label) at ~5 s each, but the UI doesn't wait on it.

Stores that can't stage answer 501 and the engine falls back to the one-by-one path, which is idempotent. `local-fs` takes that path.

## Not built, and why

1. **Key rotation (spec P2).** Deliberately not rushed. It rewrites every label under a new key, replaces `vault.json` and the server's write-auth key, needs the family password *and* a fresh recovery code (neither old envelope can be re-wrapped without its secret), drops every passkey envelope, and has to be resumable: a rotation that dies halfway with some labels under each key is exactly the "can't get a document back" failure this product exists to prevent. It also has to get past the TOFU key-fingerprint check on other devices legitimately (sketch: derive a signing keypair from the vault key, store the public half as the fingerprint, and have the old key sign the new one). The content objects embed a wrap under the old key, so `fetchDocument` needs a fallback to the label's wrap. Worth a design review before code.
2. **Cloud backup mirror** (Drive etc., B-17). Needs an OAuth client the owner registers; nothing to build against until then.
3. QR enrolment, PDF compression, encrypted thumbnails, multiple vaults (spec P2).
4. **Rate limits are in-memory.** Real on one Node process; per-instance on serverless. Swap the map in `src/server/rate-limit.ts` for a KV.
5. Removing a device doesn't rotate the vault key, and the copy says so rather than pretending.

## Do these next, in this order

1. Empty the store repo (it holds a test vault) and run the family's real setup. Write the recovery code down for real this time.
2. Deploy somewhere with HTTPS on the domain you intend to keep forever (passkeys are origin-bound), and do the passkey pass on real phones.
3. Get the owner's yes/no on the Appendix B decisions above, B-9 especially: it decides what parents can and can't do.
4. Decide whether key rotation is wanted at all before designing it.

## Deploying to Vercel

Same env vars work. What matters:

- **Build command must be `npm run build`** (pinned in `vercel.json`). Plain `next build` skips the second pass, the CSP gets no script hashes, and production renders a blank page.
- **Every API route sets `maxDuration = 60`.** A GitHub-backed write is several API calls in a row (setup is three commits). Don't rely on a platform default.
- **Leave the function region in the US** (Vercel's default). GitHub's API is there; each request makes 1–6 GitHub calls, so one India↔US hop plus fast GitHub calls beats Mumbai functions making slow ones.
- **Set env vars for Production only.** Preview deployments would otherwise share the family's real store. Vercel's preview toolbar is also a third-party script, which the CSP blocks (console noise on previews, nothing else).
- **The domain is `vault.chakri.me`.** In Vercel set `WEBAUTHN_RP_ID=vault.chakri.me` and `WEBAUTHN_ORIGIN=https://vault.chakri.me`. Unset, the passkey domain is whatever host serves the request, so a visit via the `*.vercel.app` alias would enrol passkeys that die on the real domain. Don't put these two in the local `.env`: localhost would then fail every passkey ceremony on an origin mismatch. (`chakri.me` as the RP ID would let passkeys survive a move to another subdomain, but would also let every other `*.chakri.me` site ask for them. For a vault, the narrow one.)
- **Set `SETUP_TOKEN`.** Between emptying the store and running setup, anyone who finds the URL could claim it.
- Keep Vercel Analytics and Speed Insights off: spec says zero analytics, and the CSP would block them anyway.
- The fine-grained GitHub token expires (a year at most). When it does, the vault keeps opening offline but nothing saves; the app says storage is unavailable. Put the renewal in a calendar.
- Known softness on serverless: rate limits are per warm instance, and the `registry.json` / `vault.json` caches mean another instance takes up to a minute to notice a changed password or a removed device.
- After the first deploy, check: `/precache.json` exists (else the offline shell is thinner), `/sw.js` is served as JavaScript, the console shows no CSP violations, and a PDF opens.

## Things that will bite you

- **The build runs twice** (`scripts/build.mjs`): pass one discovers each page's inline scripts, pass two pins their hashes into a per-route CSP, and it fails if the passes differ. Any page that becomes dynamic loses its hashes and will render blank in production. Keep pages static. `generateBuildId` is fixed for the same reason.
- **"Empty repo" is two different states.** No commits at all: the Git Data API refuses everything and the adapter bootstraps through the contents API. One commit pointing at git's empty tree (`4b825dc6…`; what you get after deleting every file, or `--allow-empty`): GitHub 404s that tree and won't accept it as `base_tree`. The adapter treats it as "no files" and builds a whole tree. The second one would have failed the family's first write; it's in the fake and tested now.
- **Don't bundle the PDF.js worker.** Production tree-shaking removed its start-up side effect and it sat there alive and silent. It's served as the stock file from `/pdfjs/` (copied by `scripts/copy-pdfjs.mjs`).
- **Anything cached on `globalThis` survives a dev reload** (the store provider, the registry, `vault.json`). The provider is rebuilt when its class changes, because a stale instance once answered 501 for a method that had just been added. If a server change "isn't taking", restart `next dev`.
- Server-side caches: `registry.json` 60 s, `vault.json` 30 s. Every write path reads fresh. The TTL is how long *another* instance takes to notice a removed device.
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
