// PDF.js needs a few runtime assets (image decoders, character maps, the 14
// standard fonts). They're served first-party from /pdfjs — never a CDN, which
// would break the CSP and tell a third party every time a document is opened.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "pdfjs-dist");
const to = join(root, "public", "pdfjs");

if (!existsSync(from)) process.exit(0); // nothing installed yet
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
// The worker is copied as-is rather than bundled: it's a module that exists only
// for its start-up side effect, and a production bundler is entitled to drop that.
cpSync(join(from, "build", "pdf.worker.min.mjs"), join(to, "pdf.worker.min.mjs"));
for (const dir of ["wasm", "cmaps", "standard_fonts"]) {
  if (existsSync(join(from, dir))) cpSync(join(from, dir), join(to, dir), { recursive: true });
}
