"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";

export interface ToastAction {
  /** One word, usually "Undo". */
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  /** Past tense, names the thing: "Moved Aadhaar — Chakri to trash". */
  message: string;
  action?: ToastAction;
  /** ms. Defaults to 6 s, or 10 s when there's an action. Expiry undo passes 30 000. */
  duration?: number;
}

interface ToastApi {
  /** Shows a toast, replacing any current one. Returns a dismiss function. */
  toast: (options: ToastOptions) => () => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a <ToastProvider> above it");
  return api;
}

interface ActiveToast extends ToastOptions {
  id: number;
  leaving: boolean;
}

const EXIT_MS = 180;

interface Timers {
  hide?: ReturnType<typeof setTimeout>;
  remove?: ReturnType<typeof setTimeout>;
}

function clearTimers(t: Timers) {
  clearTimeout(t.hide);
  clearTimeout(t.remove);
}

/**
 * One toast at a time: a second replaces the first. It sits 12 px above the
 * bottom bar when there is one (BottomBar flags <html data-bottom-bar>).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveToast | null>(null);
  const nextId = useRef(1);
  const currentId = useRef(0);
  const timers = useRef<Timers>({});

  const dismiss = useCallback(() => {
    const t = timers.current;
    clearTimers(t);
    setActive((a) => (a ? { ...a, leaving: true } : a));
    t.remove = setTimeout(() => {
      currentId.current = 0;
      setActive(null);
    }, EXIT_MS);
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const t = timers.current;
      clearTimers(t);
      const id = nextId.current++;
      currentId.current = id;
      setActive({ ...options, id, leaving: false });
      t.hide = setTimeout(dismiss, options.duration ?? (options.action ? 10_000 : 6_000));
      return () => {
        if (currentId.current === id) dismiss();
      };
    },
    [dismiss],
  );

  useEffect(() => {
    const t = timers.current;
    return () => clearTimers(t);
  }, []);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className={cn(
          "pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-4",
          "bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]",
          "max-lg:[[data-bottom-bar]_&]:bottom-[calc(env(safe-area-inset-bottom)+4.75rem)]",
          "lg:bottom-6",
        )}
      >
        {active && (
          <div
            key={active.id}
            className={cn(
              "pointer-events-auto flex min-h-13 w-full max-w-[26.25rem] items-center gap-3 rounded-md bg-ink py-2 pr-1.5 pl-4",
              "text-callout text-on-ink shadow-float",
              active.leaving ? "anim-toast-out" : "anim-toast-in",
            )}
          >
            <span className="flex-1 py-1.5">{active.message}</span>
            {active.action && (
              <button
                type="button"
                className="min-h-11 shrink-0 rounded-full px-2.5 text-label font-semibold text-accent-inverse transition-opacity hover:opacity-85 active:opacity-70 focus-visible:outline-accent-inverse"
                onClick={() => {
                  active.action?.onAction();
                  dismiss();
                }}
              >
                {active.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
