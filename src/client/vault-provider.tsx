"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { VaultRpc } from "./rpc";
import type { VaultState } from "./session-core";
import { createVaultWorker } from "./worker-client";

const INITIAL: VaultState = {
  phase: "loading", config: null, index: null, sync: null, role: null, via: null,
  needsSession: false, needsRepair: false, onDevice: [],
  prefs: { keepEverythingOffline: true, pins: [], lockAfterMinutes: 5, activeProfileId: null, recent: [], backupEvery: "change" },
  cacheBytes: 0,
};

interface VaultContextValue {
  state: VaultState;
  rpc: VaultRpc;
  online: boolean;
  lock: () => Promise<void>;
  /**
   * A blob: URL for a decrypted document. Every one is tracked here, so locking
   * revokes them all without depending on any component's cleanup running (§24).
   */
  createPreviewUrl: (content: Uint8Array<ArrayBuffer>, mimeType: string) => string;
  revokePreviewUrl: (url: string) => void;
}

/** During server rendering there's no worker. Nothing should call it there; if something does, fail loudly. */
const NO_RPC = new Proxy({}, {
  get: () => () => Promise.reject(new Error("the vault is only available in the browser")),
}) as VaultRpc;

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used inside <VaultProvider>");
  return ctx;
}

const ACTIVITY = ["pointerdown", "keydown", "scroll", "touchstart"] as const;

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<VaultState>(INITIAL);
  const [online, setOnline] = useState(true);
  // The worker outlives re-renders and dies with the page. A reload is a fresh start, and a fresh start is locked (§18).
  const [worker] = useState(() => (typeof window === "undefined" ? null : createVaultWorker(setState)));
  const started = useRef(false);
  const urls = useRef(new Set<string>());
  const rpc = worker?.rpc ?? NO_RPC;

  useEffect(() => {
    if (started.current || !worker) return;
    started.current = true;
    void worker.rpc.init();
    // Development only: drive the vault from the console or from browser automation.
    // Dead code in a production build, so there is no handle on the worker there.
    if (process.env.NODE_ENV !== "production") (window as unknown as { __vault?: VaultRpc }).__vault = worker.rpc;
  }, [worker]);

  const revokeAll = useCallback(() => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
  }, []);

  const lock = useCallback(async () => {
    revokeAll();
    await rpc.lock();
  }, [rpc, revokeAll]);

  const createPreviewUrl = useCallback((content: Uint8Array<ArrayBuffer>, mimeType: string) => {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    urls.current.add(url);
    return url;
  }, []);

  const revokePreviewUrl = useCallback((url: string) => {
    URL.revokeObjectURL(url);
    urls.current.delete(url);
  }, []);

  // however the lock happened (button, timer, another tab of logic), no preview survives it
  useEffect(() => {
    if (state.phase !== "unlocked") revokeAll();
  }, [state.phase, revokeAll]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // §5.4 automatic lock: inactivity, measured on wall-clock time so a sleeping phone still counts
  const unlocked = state.phase === "unlocked";
  const minutes = state.prefs.lockAfterMinutes;
  useEffect(() => {
    if (!unlocked || !minutes) return;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    const check = () => { if (Date.now() - last >= minutes * 60_000) void lock(); };
    const timer = setInterval(check, 5_000);
    for (const e of ACTIVITY) window.addEventListener(e, touch, { passive: true });
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      for (const e of ACTIVITY) window.removeEventListener(e, touch);
      document.removeEventListener("visibilitychange", check);
    };
  }, [unlocked, minutes, lock]);

  // iOS may evict IndexedDB from an idle web app. Ask to be kept; Settings reports the answer (§18.1).
  useEffect(() => {
    if (unlocked) void navigator.storage?.persist?.().catch(() => false);
  }, [unlocked]);

  useEffect(() => () => revokeAll(), [revokeAll]);

  const value = useMemo<VaultContextValue>(
    () => ({ state, rpc, online, lock, createPreviewUrl, revokePreviewUrl }),
    [state, rpc, online, lock, createPreviewUrl, revokePreviewUrl],
  );
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}
