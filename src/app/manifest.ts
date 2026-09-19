import type { MetadataRoute } from "next";

// §11.1 applies here too: the name and nothing else. No description of what's inside.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Family Vault",
    short_name: "Family Vault",
    description: "A private family document vault.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Android paints the launch splash in these before any CSS loads, and a manifest
    // can't ask prefers-color-scheme. So it's the icon's own fill in both themes: the
    // tile melts into it and only the cabinet shows. No more flashbang at midnight.
    background_color: "#161917",
    theme_color: "#161917",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Add document", url: "/?add=1" },
      { name: "Search", url: "/search" },
      // opening the app from a shortcut is a fresh start, and a fresh start is locked
      { name: "Lock", url: "/" },
    ],
    // Android and desktop Chromium only. iOS doesn't offer installed web apps a share-sheet entry (§12.2).
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: { files: [{ name: "files", accept: ["image/*", "application/pdf", "text/plain", "*/*"] }] },
    },
  };
}
