import { existsSync, readFileSync } from "node:fs";
import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

// Written by scripts/build.mjs between its two passes: route → hashes of that page's inline scripts.
const inlineHashes: Record<string, string[]> = existsSync(".csp-hashes.json")
  ? JSON.parse(readFileSync(".csp-hashes.json", "utf8"))
  : {};

/**
 * §6.7. First-party only: no third-party origin appears anywhere in this policy.
 *
 * No nonces, on purpose. A nonce makes every page render per-request, and the
 * service worker would then serve cached HTML carrying a stale nonce — so an
 * offline shell and a nonce-based CSP can't coexist. Every page is static
 * instead, which lets each route's policy list the sha-256 of exactly the
 * inline scripts Next put in that page (scripts/build.mjs), with Subresource
 * Integrity on the external ones. No 'unsafe-inline', no 'unsafe-eval'.
 *
 * - 'wasm-unsafe-eval' is for Argon2id and PDF.js's image decoders. It allows
 *   compiling WebAssembly, not eval().
 * - style-src-attr 'unsafe-inline' allows style="" attributes only (a progress
 *   bar's width). It does not allow <style> blocks, and a style attribute
 *   can't run script.
 * - development needs eval and inline script for React Refresh; production gets neither.
 */
const csp = (hashes: string[] = []) => [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval' 'unsafe-inline'" : hashes.map((h) => ` '${h}'`).join("")}`,
  `style-src 'self'${dev ? " 'unsafe-inline'" : ""}`,
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const denied = [
  "accelerometer", "ambient-light-sensor", "autoplay", "battery", "bluetooth", "browsing-topics", "camera",
  "display-capture", "encrypted-media", "fullscreen", "geolocation", "gyroscope", "hid", "idle-detection",
  "local-fonts", "magnetometer", "microphone", "midi", "payment", "picture-in-picture", "screen-wake-lock",
  "serial", "usb", "xr-spatial-tracking",
];
// everything off, except the two WebAuthn calls the app exists to make
const permissions = [...denied.map((f) => `${f}=()`), "publickey-credentials-get=(self)", "publickey-credentials-create=(self)"].join(", ");

const nextConfig: NextConfig = {
  // lets several dev servers run side by side (each with its own store) without fighting over .next
  distDir: process.env.FV_DIST_DIR || ".next",
  poweredByHeader: false,
  // the build id is inside those inline scripts, so it has to be the same on both passes
  generateBuildId: async () => process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.COMMIT_SHA ?? "local",
  experimental: { sri: { algorithm: "sha256" } },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // any path that isn't a page renders the not-found page, so that's the default set
          { key: "Content-Security-Policy", value: csp(inlineHashes["/_not-found"]) },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: permissions },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
        ],
      },
      // later entries win: each page gets the policy that names its own scripts
      ...Object.entries(inlineHashes)
        .filter(([route]) => !route.startsWith("/_"))
        .map(([route, hashes]) => ({ source: route, headers: [{ key: "Content-Security-Policy", value: csp(hashes) }] })),
    ];
  },
};

export default nextConfig;
