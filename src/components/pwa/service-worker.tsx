"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useVault } from "@/client/vault-provider";
import { useShell } from "@/components/app-shell";
import { setPendingFiles } from "@/components/upload/pending-files";

/** Registers the shell cache. Production only: in development it would serve stale code. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
  return null;
}

/**
 * The pieces that load on demand — the PDF engine, the image worker — are
 * fetched once, in the background, soon after the first unlock. From then on
 * the service worker can serve them with no network.
 */
export function OfflineWarmUp() {
  const { state } = useVault();
  const unlocked = state.phase === "unlocked";
  useEffect(() => {
    if (!unlocked || !navigator.onLine) return;
    const timer = setTimeout(() => {
      void import("@/components/preview/pdf-pages").then((m) => m.warmPdfViewer()).catch(() => {});
      void import("@/compression/image-client").then((m) => m.warmImageWorker()).catch(() => {});
    }, 4000);
    return () => clearTimeout(timer);
  }, [unlocked]);
  return null;
}

/**
 * Picks up what the app was opened *for* — a file from the share sheet, or the
 * "Add document" shortcut — once the vault is unlocked. Shared files were held
 * by the service worker in memory; they come over by message and go straight to
 * the review screen.
 */
export function LaunchIntent() {
  const { state } = useVault();
  const { openAdd } = useShell();
  const router = useRouter();
  const unlocked = state.phase === "unlocked";

  useEffect(() => {
    if (!unlocked) return;
    const params = new URLSearchParams(window.location.search);
    if (params.has("add")) {
      router.replace("/");
      openAdd();
      return;
    }
    if (!params.has("shared")) return;
    router.replace("/");
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return void router.push("/add");
    const onMessage = (e: MessageEvent<{ sharedFiles?: File[] }>) => {
      if (!e.data?.sharedFiles) return;
      navigator.serviceWorker.removeEventListener("message", onMessage);
      // none left means the worker was stopped while the vault was locked: /add says "choose a file"
      setPendingFiles(e.data.sharedFiles);
      router.push("/add");
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    sw.postMessage("take-shared-files");
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [unlocked, router, openAdd]);

  return null;
}
