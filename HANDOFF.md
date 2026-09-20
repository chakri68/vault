# Handoff

State as of 20 Sep 2026. Read this, then `spec.md` (behaviour) and `ui_theme.md` (design + all copy). Both are gitignored, so they're only on the machine that has them.

## Where it stands

The vault works end to end, against `local-fs`, against a real private GitHub repo, and — since 20 Sep 2026 — against the Cloudflare R2 bucket it now actually runs on: setup, unlock, add, view, search, edit, trash, offline, backup, restore, Repair. No passkey has ever been enrolled (no authenticator on the dev machine). That's the one real unknown left; everything else below is either tested or labelled.

`main` is clean and builds. 121 unit/integration tests, plus 13 that run over HTTP against a live server and 5 against a real R2 bucket (both opt-in).

**The family's real vault is live** at `vault.chakri.me`, 19 documents, stored in R2 (`family-vault`, APAC). Setup was run on the production domain, so the passkeys are bound to the right origin.

The old GitHub store (`chakri68/vault-storage`) still holds a byte-identical copy of all 19 documents and is the rollback: set `STORAGE_PROVIDER=github` and it serves again. The migration never wrote to it. Keep it until R2 has proven itself over a few weeks, then empty it — its git history also still holds the earlier throwaway test vault, which is harmless (ciphertext whose keys are gone).

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
   no keys, ever         holds the VMK              ciphertext     r2 | github | local-fs
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

Deviations not in Appendix B: object ids travel in a signed `x-fv-object` header, not the URL (hosts log URLs); plain `fetch` to GitHub instead of Octokit, and hand-rolled SigV4 (`src/storage/sigv4.ts`) to R2 instead of `@aws-sdk/client-s3` — a large dependency for four operations; `PUT` with client-made ids instead of `POST /api/objects` (idempotent retries); **all dates and times display in IST** regardless of device clock (`src/lib/format.ts`; never use local `Date` getters for display).

## Verified, and how

| What | How |
|---|---|
| Crypto, container, padding, recovery code, envelopes | unit tests |
| Merge | property tests: commutative, associative, idempotent, nothing lost except to a tombstone |
| Engine: CAS conflicts, orphans, rebuild with index deleted, trash/purge, offline queue replay | integration tests, memory provider |
| Backup mirror + verify, disaster recovery | tests, and once for real in Chrome: `.zip` → empty deployment → recovery code only → store byte-identical |
| GitHub adapter | tests against `src/storage/fake-github.ts`, **and** a real private repo: empty-repo bootstrap, setup, the round-trip self test, uploads, edits, a second device, wrong password, Repair |
| R2 adapter | tests against `src/storage/fake-r2.ts` (paths, CAS, 409, pagination, ETag unquoting, the whole engine on the non-batched path), **and** `r2.live.test.ts` against a real bucket — which is the only thing that can confirm a SigV4 signature, since a fake would just reproduce the signer's own mistakes |
| The migration | all 41 files read back from R2 and sha-256 matched; a second dry run reports 41/41 identical; `server/registry.json` independently refetched via `wrangler` at the same 1816 bytes |
| Nothing readable in the real store | pulled all 34 blobs and the commit log via `gh`: no names, numbers, tags or MIME types anywhere; filenames are `objects/<uuid>.vault`; commit messages are five generic strings |
| API auth, CSRF, write-auth, CAS, delete precondition, rate limiting | 12 tests over real HTTP; no object ids in request logs |
| Setup, lock, add (EXIF stripped from the *stored* bytes), document, viewer (image + PDF), search, trash, people, categories, settings | walked in Chrome at phone width |
| Offline | production build, network off, hard reload, unlock, open a PDF |
| CSP | production build, zero violations, no `unsafe-inline`/`unsafe-eval` |
| Layout | 1280 px sidebar layout; 200% text on every route, no sideways scroll |
| No plaintext at rest | grepped the store, IndexedDB, Cache Storage and the export |

## Not verified

- **R2 at scale and under contention.** The live test proves the bucket enforces compare-and-swap, but with one writer. Not yet seen for real: two devices racing on R2 (covered against the fake only), a vault of hundreds, a listing past the 1000-key page boundary with real data, and a big Repair or backup from a serverless host rather than one long-lived Node process.
- **R2 writes from inside a Vercel function.** Every number below was measured from a laptop on home broadband. The function now sits in `bom1`, same region as the bucket, and that hop has never been timed.
- **Every passkey path.** No platform authenticator on the dev machine. Enrol, unlock, PRF-at-create vs PRF-needs-second-prompt, offline passkey unlock, `resumeSession` are all untested. Needs a real Android phone and an iPhone. The no-PRF fallback notice *is* verified.
- **Automatic backups and the folder backup UI.** The native folder picker can't be automated. The mirror logic underneath is tested.
- **Share target** (Android share sheet → service worker → `/add`). Needs an installed PWA on Android.
- Camera capture row, Web Share, pinch zoom, `prefers-reduced-motion` in a browser, tablet width, iOS anything.

## What the store costs

**R2, measured 20 Sep 2026** — same laptop, same home connection, same files, median of 6 warm requests:

| GET | GitHub | R2 |
|---|---|---|
| 17 KB (`index.vault`) | 700 ms | **308 ms** |
| 1.0 MB object | 4,965 ms | **1,883 ms** |
| 3.1 MB object | 8,020 ms | **6,625 ms** |
| 1.0 MB PUT | ~6 calls | **2,111 ms, one call** |

R2 also varies far less: 286–328 ms on the small file against GitHub's 308–936 ms.

Read the 3.1 MB row carefully. 1 MB in 1,883 ms is ~4.5 Mbps, so the large files are **bandwidth-bound on the measuring link, not provider-bound** — both stores are just filling the same pipe. The 17 KB row is the honest latency comparison. None of this is the production number: `bom1` → R2 APAC is same-region datacenter networking and is untimed.

The rest of this section is the GitHub history that shaped the engine, kept because it explains why the code looks the way it does.

About **one second per API call** from India, and that number drove everything. Measured on the real repo:

| | before | now |
|---|---|---|
| upload 1 document | 15.3 s | 7.6 s |
| upload 8 documents | ~80 s (extrapolated) | 12.3 s |
| Repair, 15 documents | 17.5 s | 9.1 s |
| unlock, device already has the list | 2.2 s | 0.3–0.5 s |
| open one document (not yet on the device) | | 1.4 s |

Unlock doesn't wait on the store any more: a device with a cached index opens from it at once and merges the fresh one in behind the scenes (`refreshInBackground`). Only a device that has never seen the vault waits. Document ciphertext was always fetched in the background, now three at a time.

What got the rest there: blobs staged in parallel (`PUT /api/vault/stage`, no commit needed) then **one atomic commit** for parts + labels + index (`POST /api/vault/commit`, B-16); 5 sequential calls per commit instead of ~7; `registry.json` and `vault.json` cached server-side (they were a GitHub read on nearly every request); Repair reads labels eight at a time. An edit is still two commits (index, then label) at ~5 s each, but the UI doesn't wait on it.

Stores that can't stage answer 501 and the engine falls back to the one-by-one path, which is idempotent. `local-fs` takes that path — **and so does R2**, which has no multi-object write. So B-16 is now dead weight in production: `batchingStore()` returns null, `/api/vault/stage` 501s, and `engine.pushBatch` sets `batchUnsupported` on the first try. That's safe rather than merely tolerable, because content is immutable and written create-only *before* the index names it, so the index CAS is the only thing that makes an object visible and a half-finished upload leaves unreferenced files that `findOrphans`/`rebuild` already reconcile.

If the batching speedup is ever wanted back on R2, the move is to parallelise the part PUTs in `engine.syncOnce` step 1 — not to revive `stage`/`commitStaged`. N parallel create-only PUTs plus one CAS on the index beats GitHub's six sequential calls anyway.

## Not built, and why

1. **Key rotation (spec P2).** Deliberately not rushed. It rewrites every label under a new key, replaces `vault.json` and the server's write-auth key, needs the family password *and* a fresh recovery code (neither old envelope can be re-wrapped without its secret), drops every passkey envelope, and has to be resumable: a rotation that dies halfway with some labels under each key is exactly the "can't get a document back" failure this product exists to prevent. It also has to get past the TOFU key-fingerprint check on other devices legitimately (sketch: derive a signing keypair from the vault key, store the public half as the fingerprint, and have the old key sign the new one). The content objects embed a wrap under the old key, so `fetchDocument` needs a fallback to the label's wrap. Worth a design review before code.
2. **Cloud backup mirror** (Drive etc., B-17). Needs an OAuth client the owner registers; nothing to build against until then.
3. QR enrolment, encrypted thumbnails, multiple vaults (spec P2).
   **PDF compression: looked at on 20 Sep 2026 and deliberately dropped.** Nothing compresses stored bytes today — `src/compression/` is image *re-encoding* whose real job is stripping EXIF/GPS, `fflate` is only the `.fvault` zip, and PDFs are saved as they are. Adding a deflate pass would gain roughly nothing, because scanned documents are already JPEG/JPX inside the PDF's content streams. The only real lever is re-encoding the images *inside* the PDF at lower resolution, and §15's own argument cuts against it: an Aadhaar a government portal rejects is worse than a large one. Note also that padding rounds *up* (16 KB, 64 KB, 256 KB, 1 MB, then whole MB), so a document a byte over 1 MiB is stored as 2 MiB — that waste is the §4.7 side-channel tradeoff, not something compression fixes.
4. **Rate limits are in-memory.** Real on one Node process; per-instance on serverless. Swap the map in `src/server/rate-limit.ts` for a KV.
5. Removing a device doesn't rotate the vault key, and the copy says so rather than pretending.

## Do these next, in this order

1. **Do the passkey pass on real phones** against `vault.chakri.me`. Still the one genuinely untested path, and now the only thing between this and "done".
2. Get the owner's yes/no on the Appendix B decisions above, B-9 especially: it decides what parents can and can't do.
3. Decide whether key rotation is wanted at all before designing it.
4. Once R2 has run a few weeks without trouble, empty `chakri68/vault-storage`. Not before — it is the rollback.

Done since the last handoff: the family's real setup (19 documents), the deploy to `vault.chakri.me`, and the move to R2.

## Deploying to Vercel

Same env vars work. What matters:

- **Build command must be `npm run build`** (pinned in `vercel.json`). Plain `next build` skips the second pass, the CSP gets no script hashes, and production renders a blank page.
- **Every API route sets `maxDuration = 60`.** Sized for GitHub, where a write is six sequential API calls (setup is three commits). On R2 a write is one request, so this is now generous rather than necessary — leave it until there are real R2 numbers from inside a function, then trim.
- **Keep the function region at Mumbai (`bom1`).** This reverses the old advice, which said to leave it in the US because GitHub's API lived there. The store is now an APAC R2 bucket, so the function must sit beside it: a US function would cross the Pacific for every read and be *slower than GitHub was*. Confirm with `curl -sD- https://vault.chakri.me/api/vault/config | grep x-vercel-id` — the second field is where the function ran, and it should read `bom1::bom1`.
- **Set env vars for Production only.** Preview deployments would otherwise share the family's real store. Vercel's preview toolbar is also a third-party script, which the CSP blocks (console noise on previews, nothing else).
- **The domain is `vault.chakri.me`.** In Vercel set `WEBAUTHN_RP_ID=vault.chakri.me` and `WEBAUTHN_ORIGIN=https://vault.chakri.me`. Unset, the passkey domain is whatever host serves the request, so a visit via the `*.vercel.app` alias would enrol passkeys that die on the real domain. Don't put these two in the local `.env`: localhost would then fail every passkey ceremony on an origin mismatch. (`chakri.me` as the RP ID would let passkeys survive a move to another subdomain, but would also let every other `*.chakri.me` site ask for them. For a vault, the narrow one.)
- **Set `SETUP_TOKEN`.** Between emptying the store and running setup, anyone who finds the URL could claim it.
- Keep Vercel Analytics and Speed Insights off: spec says zero analytics, and the CSP would block them anyway.
- **R2 credentials are S3 keys, not a Cloudflare API token.** `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` come from R2 → Manage API Tokens → Object Read & Write, scoped to the one bucket. A `wrangler login` does not authenticate against the S3 endpoint, and `wrangler` cannot mint these — it has no token subcommand, so this is a dashboard-only step. They don't expire by default, so there's no renewal to diarise (unlike the old GitHub PAT, which did, at a year).
- **Leave the bucket private.** Don't attach an `r2.dev` URL or a custom domain. Nothing in the code can detect one: bucket visibility is Cloudflare-API state, invisible over the S3 API, so unlike the GitHub adapter's "must be private" check there is no guard here. Encryption is the real control; a public store is an acceptable-use problem.
- **Local dev on a network without IPv6 needs `NODE_OPTIONS=--dns-result-order=ipv4first`.** Node otherwise resolves Cloudflare's AAAA records some of the time and the connection dies with `ENETUNREACH`, which surfaces as random "storage unavailable". This broke the migration twice before `scripts/migrate-to-r2.mts` was made to force IPv4. Vercel's network has working IPv6, so production is unaffected.
- Known softness on serverless: rate limits are per warm instance, and the `registry.json` / `vault.json` caches mean another instance takes up to a minute to notice a changed password or a removed device. That 60 s TTL in `src/server/registry.ts` exists only because a GitHub read cost about a second. An R2 read is ~300 ms from a laptop and much less from `bom1`, so the TTL can now be cut hard — which shortens the window where a revoked device still works. Worth doing; it's a security-latency win, not a speed one.
- After the first deploy, check: `/precache.json` exists (else the offline shell is thinner), `/sw.js` is served as JavaScript, the console shows no CSP violations, and a PDF opens.

## Things that will bite you

- **The build runs twice** (`scripts/build.mjs`): pass one discovers each page's inline scripts, pass two pins their hashes into a per-route CSP, and it fails if the passes differ. Any page that becomes dynamic loses its hashes and will render blank in production. Keep pages static. `generateBuildId` is fixed for the same reason.
- **"Empty repo" is two different states** (GitHub adapter only; R2 has no equivalent, an empty bucket is just empty). No commits at all: the Git Data API refuses everything and the adapter bootstraps through the contents API. One commit pointing at git's empty tree (`4b825dc6…`; what you get after deleting every file, or `--allow-empty`): GitHub 404s that tree and won't accept it as `base_tree`. The adapter treats it as "no files" and builds a whole tree. The second one would have failed the family's first write; it's in the fake and tested now.
- **Service worker vs. web workers.** Turbopack hands a worker its chunk list in the URL `#fragment`. A Response that carries its own `url` (anything from `fetch` or the Cache API) replaces the worker's location, the fragment disappears, the bootstrap logs "Missing worker bootstrap config", and the app sits blank on its loading state with nothing else in the console. `sw.js` re-wraps worker scripts in a url-less Response (`forWorker`). If the app is ever blank in production, check the console for that line first.
- **The domain had a previous tenant.** `vault.chakri.me` used to serve a different (Vite) app with its own service worker, which kept showing its cached page to browsers that had visited it: blank screen, requests for `/assets/*` that 404. On activation `sw.js` now deletes every cache that isn't ours and, only when it found a foreign one, reloads the open tabs once. It never reloads on an ordinary update, because a reload locks the vault.
- **The sync queue is per device, and "pending" means what a person is waiting on.** `dirty.json` in IndexedDB holds uploads, label edits and file-cleanup notes. Only the first two count towards "Saving N changes…": once a permanent delete's tombstone is in the index the change is saved, and removing the files is housekeeping. Cleanup needs an admin session, but *any* session drops a note whose files are already gone (it checks once per unlock). This mattered on day one: the device that runs setup queues the self-test's cleanup; if that stumbles and the device next unlocks with the family password (a member, once a passkey exists), the note used to sit there as "Saving 1 change…" forever.
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
- Plaintext never rests anywhere: not IndexedDB, not Cache Storage, not the service worker (shared files wait in its memory, then the page's, only).
- No filename, person, category or object id in a URL, a log line, or a commit message.
- Every preview URL goes through `createPreviewUrl`, so lock can revoke it without trusting component cleanup.
- The lock screen shows nothing: no counts, no names. The document title is always "Family Vault".
- UI copy: deleted means *removed from your vault*, never erased; nothing implies one family member can't read another's documents; no crypto words outside Settings → Technical details.
