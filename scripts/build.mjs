// Two passes. The first build tells us what the pages' inline scripts are; the
// second bakes their hashes into each route's Content-Security-Policy. Then the
// hashes are collected once more and compared: if the build isn't reproducible
// the policy would block the app, and it's better to fail here than in a browser.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectCspHashes } from "./csp-hashes.mjs";

// Everything the app needs to run with no network: every built script, style and
// font, plus the PDF engine's decoders and standard fonts. (Not the CJK character
// maps: 1.7 MB that most family paperwork never touches; they load on demand.)
function collectAssets() {
  const out = [];
  const walk = (dir, url) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${url}/${name}`);
      else if (!name.endsWith(".map")) out.push(`${url}/${encodeURIComponent(name).replace(/%5B/g, "[").replace(/%5D/g, "]")}`);
    }
  };
  walk(join(".next", "static"), "/_next/static");
  out.push("/pdfjs/pdf.worker.min.mjs");
  walk(join("public", "pdfjs", "wasm"), "/pdfjs/wasm");
  walk(join("public", "pdfjs", "standard_fonts"), "/pdfjs/standard_fonts");
  walk(join("public", "icons"), "/icons");
  return out.sort();
}
const PRECACHE = join("public", "precache.json");

const FILE = ".csp-hashes.json";
const build = () => {
  const r = spawnSync("npx", ["next", "build"], { stdio: "inherit", env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

rmSync(FILE, { force: true });
rmSync(PRECACHE, { force: true });
console.log("\n[1/2] building to discover inline scripts…");
build();
const first = collectCspHashes();
writeFileSync(FILE, JSON.stringify(first, null, 2));
const assets = collectAssets();
writeFileSync(PRECACHE, JSON.stringify(assets));

console.log(`\n[2/2] rebuilding with a per-route policy (${Object.keys(first).length} pages)…`);
build();
const second = collectCspHashes();
if (JSON.stringify(assets) !== JSON.stringify(collectAssets())) {
  console.error("\nThe two builds produced different asset names, so the offline shell would be missing files. Not shipping this.");
  process.exit(1);
}
if (JSON.stringify(first) !== JSON.stringify(second)) {
  console.error("\nThe two builds produced different inline scripts, so the policy would block the app. Not shipping this.");
  process.exit(1);
}
console.log(`\nContent-Security-Policy: inline scripts pinned by hash. Offline shell: ${assets.length} files. The build is reproducible.`);
