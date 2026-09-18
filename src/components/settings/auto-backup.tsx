"use client";

import { useEffect, useRef } from "react";
import { alreadyWritable, savedBackupFolder } from "@/client/folder-handle";
import { useVault } from "@/client/vault-provider";
import { useToast } from "@/components/ui";

const HOUR = 3_600_000;
const SETTLE_MS = 20_000; // an eight-file upload should make one backup, not eight

/**
 * §27.4: keeps the chosen backup folder current without being asked.
 *
 * What it honestly is: a browser tab doing the copying. It runs while the app
 * is open and unlocked, and only while the browser still holds permission to
 * the folder (it never prompts on its own). Close the app before it fires and
 * the backup waits for next time; the Backups screen goes "Stale" if that keeps
 * happening, which is the real safety net.
 *
 * A failed backup never touches the vault. It's reported, and tried again.
 */
export function AutoBackup() {
  const { state, rpc, online } = useVault();
  const { toast } = useToast();
  const running = useRef(false);
  const failedAt = useRef(0);

  const unlocked = state.phase === "unlocked";
  const every = state.prefs.backupEvery;
  const lastAt = state.prefs.lastBackup?.at;
  const changedAt = state.index?.updatedAt;
  const settled = !state.sync?.syncing && (state.sync?.pending ?? 0) === 0 && !state.sync?.problem;
  const documents = Object.keys(state.index?.entries ?? {}).length;

  useEffect(() => {
    if (!unlocked || !online || !settled || every === "manual" || documents === 0) return;
    const last = lastAt ? Date.parse(lastAt) : 0;
    const due =
      every === "change" ? !!changedAt && Date.parse(changedAt) > last
      : Date.now() - last > (every === "daily" ? 24 : 24 * 7) * HOUR;
    if (!due || Date.now() - failedAt.current < HOUR) return;

    const timer = setTimeout(async () => {
      if (running.current) return;
      const folder = await savedBackupFolder();
      if (!folder || !(await alreadyWritable(folder))) return; // no folder chosen, or the browser wants asking: leave it to the button
      running.current = true;
      try {
        const result = await rpc.backupToFolder(folder);
        if (!result.verified) throw new Error("unverified");
      } catch {
        failedAt.current = Date.now();
        toast({ message: "The backup to your folder didn't complete. Your documents are safe; it'll try again." });
      } finally {
        running.current = false;
      }
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [unlocked, online, settled, every, lastAt, changedAt, documents, rpc, toast]);

  return null;
}
