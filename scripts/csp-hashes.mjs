// Every page here is prerendered, so the inline scripts Next puts in the HTML
// (its bootstrap and the serialised component tree) are fixed at build time.
// That means they can be allowed by hash — exactly these scripts, nothing else —
// instead of by 'unsafe-inline', which would allow any injected script too.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const INLINE = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".html")) out.push(full);
  }
  return out;
}

/** { "/": ["sha256-…"], "/settings/people": […], "/_not-found": […] } */
export function collectCspHashes(distDir = ".next") {
  const root = join(distDir, "server", "app");
  if (!existsSync(root)) return {};
  const routes = {};
  for (const file of walk(root)) {
    const rel = relative(root, file).replace(/\\/g, "/").replace(/\.html$/, "");
    const route = rel === "index" ? "/" : `/${rel.replace(/\/index$/, "")}`;
    const hashes = new Set();
    for (const [, body] of readFileSync(file, "utf8").matchAll(INLINE)) {
      if (body.trim()) hashes.add(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
    }
    routes[route] = [...hashes].sort();
  }
  return routes;
}
