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
// the page asks for them. Never in Cache Storage or IndexedDB: that would be
// plaintext at rest (§17.5). If the worker is stopped first they're gone, and
// the page says "share it again".
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
    for (const name of await caches.keys()) {
      if (name.startsWith("fv-shell-") && name !== SHELL) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "take-shared-files") {
    event.source.postMessage({ sharedFiles: shared });
    shared = [];
  }
});

const isStatic = (url) =>
  url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/pdfjs/") ||
  url.pathname.startsWith("/icons/") || url.pathname === "/icon.png" || url.pathname === "/manifest.webmanifest";

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

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(bare(request));
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(bare(request), response.clone());
  return response;
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
      return Response.redirect("/?shared=1", 303);
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
