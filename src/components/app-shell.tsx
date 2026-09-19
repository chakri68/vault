"use client";

import { FolderClosed, Lock, Plus, Settings, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { VaultProvider, useVault } from "@/client/vault-provider";
import { LockScreen } from "@/components/auth/lock-screen";
import { NewPasswordPrompt } from "@/components/auth/new-password-prompt";
import { SetupFlow } from "@/components/auth/setup-flow";
import { useSetupInProgress } from "@/components/auth/setup-state";
import { StorageProblem } from "@/components/auth/storage-problem";
import { LaunchIntent, OfflineWarmUp, ServiceWorkerRegistration, SharedFilesPickup } from "@/components/pwa/service-worker";
import { AutoBackup } from "@/components/settings/auto-backup";
import { AppMark, BottomBar, Button, Icon, ToastProvider, cn } from "@/components/ui";
import { AddSheet } from "@/components/upload/add-sheet";
import { setPendingFiles } from "@/components/upload/pending-files";

interface ShellContextValue {
  /** opens the Add sheet from anywhere (empty states, the sidebar, the bottom bar) */
  openAdd: () => void;
}

const ShellContext = createContext<ShellContextValue>({ openAdd: () => {} });
export const useShell = () => useContext(ShellContext);

const NAV = [
  { href: "/", label: "Documents", icon: FolderClosed },
  { href: "/settings/people", label: "People", icon: Users },
  { href: "/settings/trash", label: "Trash", icon: Trash2 },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

/** Screens that carry the phone's bottom bar. Everything deeper has a back button instead. */
const TOP_LEVEL = new Set(["/", "/settings"]);

function Sidebar({ onAdd }: { onAdd: () => void }) {
  const pathname = usePathname();
  const { lock } = useVault();
  const active = (href: string) =>
    href === "/" || href === "/settings" ? pathname === href : pathname.startsWith(href);
  return (
    <aside className="sticky top-0 hidden h-dvh w-62 flex-none flex-col gap-6 bg-surface px-4 py-6 lg:flex">
      <div className="flex items-center gap-3 px-2">
        <AppMark size={40} />
        <span className="text-label font-semibold">Family Vault</span>
      </div>
      <Button icon={Plus} onClick={onAdd} className="w-full">Add document</Button>
      <nav aria-label="Main" className="flex flex-col gap-1">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active(item.href) ? "page" : undefined}
            className={cn(
              "flex min-h-12 items-center gap-3 rounded-md px-3 text-label transition-colors duration-150 -outline-offset-2",
              "hover:bg-pressed active:bg-pressed active:duration-0",
              active(item.href) ? "bg-sunken text-ink" : "text-ink-2",
            )}
          >
            <Icon icon={item.icon} />
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto">
        <Button variant="secondary" icon={Lock} onClick={() => void lock()} className="w-full">Lock</Button>
      </div>
    </aside>
  );
}

function Unlocked({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { state } = useVault();
  const [addOpen, setAddOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const openAdd = useCallback(() => setAddOpen(true), []);
  const shell = useMemo(() => ({ openAdd }), [openAdd]);

  // an index that won't open gets rebuilt from the labels on the files, without being asked (§8.4)
  useEffect(() => {
    if (state.needsRepair && pathname !== "/settings/repair") router.replace("/settings/repair");
  }, [state.needsRepair, pathname, router]);

  // desktop: the page accepts dropped files anywhere
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    let depth = 0;
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) {
        setPendingFiles(files);
        router.push("/add");
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [router]);

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex min-h-dvh w-full">
        <Sidebar onAdd={openAdd} />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
      {TOP_LEVEL.has(pathname) && (
        <BottomBar active={pathname === "/" ? "documents" : "settings"} onAdd={openAdd} />
      )}
      <AddSheet open={addOpen} onOpenChange={setAddOpen} />
      <NewPasswordPrompt />
      <LaunchIntent />
      <OfflineWarmUp />
      <AutoBackup />
      {dragging && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-scrim">
          <p className="rounded-lg bg-surface px-6 py-4 text-heading shadow-float">Drop to add to your vault</p>
        </div>
      )}
    </ShellContext.Provider>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { state } = useVault();
  // Creating the vault unlocks it, but setup still has steps to go: this phone's
  // fingerprint, the round-trip test, install. It stays on screen until it says it's done.
  const settingUp = useSetupInProgress();
  if (settingUp && (state.phase === "unlocked" || state.phase === "needs-setup")) return <SetupFlow />;
  switch (state.phase) {
    case "loading":
      // Nothing to show yet, and nothing should be: no counts, no names, no skeleton of what's inside (§11.1).
      return <div className="min-h-dvh" aria-busy="true" />;
    case "needs-setup":
      return <SetupFlow />;
    case "storage-problem":
    case "unreachable":
      return <StorageProblem />;
    case "locked":
      return <LockScreen />;
    case "unlocked":
      return <Unlocked>{children}</Unlocked>;
  }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <VaultProvider>
      <ToastProvider>
        <ServiceWorkerRegistration />
        <SharedFilesPickup />
        <Gate>{children}</Gate>
      </ToastProvider>
    </VaultProvider>
  );
}
