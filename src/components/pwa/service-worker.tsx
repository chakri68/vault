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
 * Files from the share sheet. The service worker holds them in memory, and an
 * idle worker is stopped after about 30 seconds: less time than typing the family
 * password takes. So the page takes them the moment it loads, locked or not, and
 * keeps them in its own memory until the vault is open. Once per page: the worker
 * hands them over only once.
 */
let shared: Promise<File[]> | null = null;

function collectSharedFiles(): Promise<File[]> {
  shared ??= new Promise((resolve) => {
    const container = navigator.serviceWorker;
    const sw = container?.controller;
    if (!sw) return resolve([]);
    const onMessage = (e: MessageEvent<{ sharedFiles?: File[] }>) => {
      if (!e.data?.sharedFiles) return;
      container.removeEventListener("message", onMessage);
      resolve(e.data.sharedFiles);
    };
    container.addEventListener("message", onMessage);
    sw.postMessage("take-shared-files");
  });
  return shared;
}

/** Mounted from the first render, under the lock screen, so the files are safe before anyone starts typing. */
export function SharedFilesPickup() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("shared")) void collectSharedFiles();
  }, []);
  return null;
}

/**
 * Picks up what the app was opened *for* — a file from the share sheet, or the
 * "Add document" shortcut — once the vault is unlocked. Shared files go straight
 * to the review screen.
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
    let alive = true;
    void collectSharedFiles().then((files) => {
      if (!alive) return;
      shared = null; // the review screen has them now; the page shouldn't hold on past a lock
      // none means the worker lost them before the page could ask (a reload, say): /add says "choose a file"
      setPendingFiles(files);
      router.push("/add");
    });
    return () => { alive = false; };
  }, [unlocked, router, openAdd]);

  return null;
}
