# Family Vault

A private document vault for the family: passports, Aadhaar, insurance, the property deed nobody can ever find. Everything gets encrypted on your device before it goes anywhere, and the "anywhere" is a private GitHub repo that only ever sees noise.

Why does this exist: because "where's Dad's passport scan" is a group-chat thread every single time, and the answer shouldn't be "scroll up in WhatsApp."

## How it actually works

- **Your device does the crypto.** Each file gets its own random AES-256-GCM key. That key is wrapped by a vault master key, which is wrapped by whatever you unlock with. The server never sees a key, a filename, or a byte of plaintext.
- **Three ways in, each independent:** the family password (Argon2id), a passkey (WebAuthn PRF, so the secret stays in the phone's secure hardware), or the printed recovery code. Setup won't finish until you've typed the recovery code back. No skip link. That's deliberate.
- **The store is dumb on purpose.** `StorageProvider` is one interface: GitHub today, a folder on disk for dev, anything S3-shaped later. Every provider holds identical bytes, so a backup taken to one restores through another.
- **Every file carries its own label.** Metadata lives encrypted inside each object *and* in an editable sidecar, so the index is just a cache. Delete it and Repair rebuilds it from the files.
- **Offline is the point.** Ciphertext is cached in IndexedDB, the app shell in a service worker. Airplane mode, hard reload, unlock, open the PDF. It works; it's tested.
- **Concurrent edits merge, they don't clobber.** The index merge is a CRDT (per-field last-writer-wins, tombstones win), property-tested for commutativity/associativity/idempotence. Offline replay is literally just another merge.

What the storage provider can still see: how many files, each one's padded size bucket, and when you wrote. That's it, and it's written down in `spec.md` §3.2 rather than hand-waved.

## Running it

```bash
npm install
cp .env.example .env      # fill in storage + SESSION_SECRET
npm run dev
```

No GitHub repo handy? `STORAGE_PROVIDER=local-fs` writes the (encrypted) store to `.vault-store/` and everything else behaves the same.

For GitHub: make a **private**, empty repo, mint a fine-grained token with *Contents: read/write* on just that repo, and set `GITHUB_PAT`, `GITHUB_OWNER`, `GITHUB_REPOSITORY`. The app refuses a public repo.

```bash
npm test                  # crypto, merge (property-based), engine, backup/restore
npm run build             # two passes — see below
npm start
```

### Why the build runs twice

The CSP has no `'unsafe-inline'` and no nonces (nonces force per-request rendering, and a service worker would serve stale ones offline). Every page is static instead, so pass one discovers each page's inline scripts, pass two bakes their SHA-256 hashes into a per-route policy, and the build fails if the two passes disagree. Slower build, strict policy, working offline shell. Fair trade.

### API security tests, over real HTTP

```bash
STORAGE_PROVIDER=local-fs LOCAL_STORE_DIR=/tmp/fv-e2e npx next dev -p 3210   # needs an EMPTY store
FV_E2E_BASE=http://localhost:3210 npx vitest run src/server/api.e2e.test.ts
```

Covers spec §40.7–9: every route rejects without a session, a session alone can't write (needs CSRF + an HMAC keyed off the unlocked vault), deletes need the current index version, rate limiting engages and backs off.

## Layout

```
src/crypto      AES-GCM, HKDF, Argon2id, container + sidecar formats, padding, recovery code
src/vault       index model, CRDT merge, the engine (upload/sync/rebuild/reconcile), backup + restore
src/storage     the provider interface; github, local-fs, local-folder (browser), memory (tests)
src/server      sessions, CSRF, write-auth, rate limits, registry, WebAuthn
src/client      API client, the session core (runs in a Web Worker and is the only thing that holds keys)
src/components  Almirah UI primitives + screens
```

`spec.md` is the behaviour, `ui_theme.md` is the design language (Almirah: named after the steel cupboard where every Indian family actually keeps the passports).

## Honest limits

- Everyone who can unlock the vault can read everything in it. People are for organising, not privacy.
- Deleting removes a document from your vault. Old copies may linger in git history and backups. That's the free undelete, not a bug.
- JavaScript can't promise memory is wiped on lock. It drops every reference and revokes every preview URL; that narrows the window, it doesn't close it.
- Rate limiting is in-memory, so on serverless it's per warm instance, not global.
- Move the app to a new domain and every passkey dies (they're origin-bound). Pick a domain and keep it.
