/**
 * The service worker, served from a route so each build gets its own cache
 * version without a bundler plugin. Hand-written and dependency-free: it is
 * short enough to read, which matters for the one script that sits between the
 * app and the network.
 *
 * What it caches: the application shell — pages, JS, CSS, fonts, icons, the
 * PDF.js assets. What it never touches: /api/*. Document ciphertext lives in
 * IndexedDB (§17), not here, so the shell can be purged and rebuilt without
 * going near the archive (§18). Decrypted previews are blob: URLs and never
 * pass through a service worker at all.
 */
export const dynamic = "force-static";

const BUILD = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.COMMIT_SHA ?? String(Date.now());

const ROUTES = [
  "/", "/search", "/categories", "/category", "/add", "/doc", "/doc/edit", "/settings", "/settings/people",
  "/settings/devices", "/settings/recovery", "/settings/backups", "/settings/trash", "/settings/repair",
  "/settings/technical", "/settings/security",
];

const source = `
const VERSION = ${JSON.stringify(BUILD)};
const SHELL = "fv-shell-" + VERSION;   // html + rsc payloads: tied to the build
const STATIC = "fv-static";            // content-hashed files: safe across builds
const ROUTES = ${JSON.stringify(ROUTES)};

// Files shared into the app from the OS share sheet wait here, in memory, until
// the page asks for them, which it does as soon as it loads, before unlock: an
// idle worker is stopped within about 30 seconds, and this memory goes with it.
// Never in Cache Storage or IndexedDB: that would be plaintext at rest (§17.5).
let shared = [];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    const assets = await caches.open(STATIC);
    const wanted = new Set();
    // best effort: a page that fails to fetch now is fetched on first visit instead
    await Promise.allSettled(ROUTES.map(async (route) => {
      const response = await fetch(new Request(route, { cache: "reload" }));
      if (!response.ok) return;
      const html = await response.clone().text();
      await shell.put(new Request(self.location.origin + route + "?__fv=html"), response);
      // the scripts, styles and fonts that page needs, so it runs offline the first time too
      for (const m of html.matchAll(/["'(](\\/_next\\/static\\/[^"')\\s]+)/g)) wanted.add(m[1]);
    }));
    // the build's own list of every script, style and font — including the ones
    // that only load on demand (the PDF engine's worker, the image worker)
    try {
      for (const url of await (await fetch("/precache.json", { cache: "reload" })).json()) wanted.add(url);
    } catch {}
    await Promise.allSettled([...wanted].map(async (url) => {
      if (!(await assets.match(url))) await assets.add(url);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // This origin is the vault's alone, so any cache that isn't ours is a leftover:
    // an older build's shell, or a different app that used to live on this domain.
    // Whatever it holds, it goes. (If that app cached anything private, all the more reason.)
    let foreign = false;
    for (const name of await caches.keys()) {
      if (name === SHELL || name === STATIC) continue;
      if (!name.startsWith("fv-")) foreign = true;
      await caches.delete(name);
    }
    await self.clients.claim();
    // Taking over from a different app means the open tab is showing *its* page,
    // asking for files that no longer exist: a blank screen that a family member
    // can't be expected to debug. Reload those tabs onto the real thing, once.
    // Never on an ordinary update: a reload locks the vault.
    if (foreign) {
      for (const client of await self.clients.matchAll({ type: "window" })) {
        client.navigate(client.url).catch(() => {});
      }
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "take-shared-files") {
    event.source.postMessage({ sharedFiles: shared });
    shared = [];
  }
});

// The manifest isn't here on purpose: it has no hash in its name, and fv-static
// outlives builds, so a cached copy would be the only one Chrome's update check
// ever saw, and an installed app would never hear about a change to it.
const isStatic = (url) =>
  url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/pdfjs/") ||
  url.pathname.startsWith("/icons/") || url.pathname === "/icon.png";

// Turbopack starts workers from a bootstrap URL with a #fragment; a fragment never
// reaches the network, so it isn't part of what's cached either.
const bare = (request) => (request.url.includes("#") ? new Request(request.url.split("#")[0]) : request);

// one cache entry per page and per kind of request, whatever the query string says:
// /doc?id=… is one page, and Next's _rsc cache-buster isn't part of a page's identity
function shellKey(request, url) {
  const kind = request.headers.get("RSC") !== "1" ? "html"
    : request.headers.get("Next-Router-Prefetch") === "1" ? "rsc-prefetch" : "rsc";
  return new Request(url.origin + url.pathname + "?__fv=" + kind);
}

async function networkFirst(request, url) {
  const cache = await caches.open(SHELL);
  const key = shellKey(request, url);
  try {
    const response = await fetch(request);
    if (response.ok && response.status === 200) await cache.put(key, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw error;
  }
}

// A worker learns its chunk list from its own URL's #fragment. A Response that
// carries a url of its own (anything from fetch or the cache does) replaces the
// worker's location with that url, and the fragment is gone: the worker starts,
// finds no config, and dies silently, leaving the app blank. A re-wrapped
// Response has no url, so the worker keeps the one it was asked for. Headers are
// copied across because the worker's own CSP comes from them.
const forWorker = (request, response) =>
  request.destination === "worker" || request.destination === "sharedworker" || request.url.includes("#")
    ? new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers })
    : response;

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(bare(request));
  if (hit) return forWorker(request, hit);
  const response = await fetch(request);
  if (response.ok) await cache.put(bare(request), response.clone());
  return forWorker(request, response);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith((async () => {
      try {
        const form = await request.formData();
        shared = form.getAll("files").filter((f) => f instanceof File);
      } catch { shared = []; }
      // The count goes along because none is a real case, and not ours: Chrome 153 on
      // Android drops the files before it builds this request (its new check on the
      // sharing app's permission turns down ordinary grants), so the body arrives
      // well-formed and empty. Only this worker sees that; the page has to be told.
      return Response.redirect("/?shared=" + shared.length, 303);
    })());
    return;
  }

  if (request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;          // ciphertext and auth: never cached here
  if (url.pathname === "/sw.js") return;
  if (isStatic(url)) return event.respondWith(cacheFirst(request));
  if (request.mode === "navigate" || request.headers.get("RSC") === "1") {
    return event.respondWith(networkFirst(request, url));
  }
});
`;

export function GET() {
  return new Response(source, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
    },
  });
}
