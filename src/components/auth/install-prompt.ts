import { useSyncExternalStore } from "react";

/** Chromium's install event. Not in lib.dom, because it isn't a standard. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// The browser fires this once, early, whether or not anyone is listening yet.
// So the listener lives at module level and holds on to the event until a
// screen wants to offer "Install".
let deferred: BeforeInstallPromptEvent | null = null;
// installed from this tab: the app is on the home screen, though this page is still a browser tab
let installedHere = false;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we'll ask at a moment that makes sense, with words around it
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedHere = true;
    notify();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** True when the browser will show its own install dialog if asked. */
export function useCanInstall(): boolean {
  return useSyncExternalStore(subscribe, () => deferred !== null, () => false);
}

export type InstallState = "installed" | "prompt" | "manual";

/**
 * "prompt": the browser shows its own install dialog when asked. "manual": it
 * won't (Safari, Firefox, or Chrome that hasn't offered yet, or was told no),
 * so point at the menu. "installed": running as the app, or just installed from here.
 */
export function useInstallState(): InstallState {
  return useSyncExternalStore(
    subscribe,
    () => (installedHere || isInstalled() ? "installed" : deferred ? "prompt" : "manual"),
    () => "manual",
  );
}

export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  try {
    await event.prompt();
  } catch (error) {
    // a spent or refused event would turn every later tap into a no-op; drop it, and the menu directions take over
    deferred = null;
    notify();
    throw error;
  }
  const { outcome } = await event.userChoice;
  deferred = null; // one event, one ask
  // appinstalled follows, but on Android only once the app is built, seconds later
  if (outcome === "accepted") installedHere = true;
  notify();
  return outcome === "accepted";
}

export function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}
