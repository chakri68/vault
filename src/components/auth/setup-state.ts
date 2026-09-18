import { useSyncExternalStore } from "react";

/**
 * Setup outlives the phase that started it. Creating the vault (step 4 → 5)
 * flips the app to "unlocked", but there are still steps to go: this phone's
 * fingerprint, the round-trip test, install. The shell asks this store whether
 * setup is still on screen, and the flow resumes from `step` if it gets remounted.
 *
 * Module-level on purpose: a reload forgets it, and a reload is a fresh, locked start.
 */
interface SetupProgress {
  active: boolean;
  step: number;
}

let progress: SetupProgress = { active: false, step: 1 };
const listeners = new Set<() => void>();

export function isSetupActive(): boolean {
  return progress.active;
}

export function getSetupStep(): number {
  return progress.step;
}

export function setSetupProgress(next: Partial<SetupProgress>): void {
  progress = { ...progress, ...next };
  for (const l of listeners) l();
}

export function endSetup(): void {
  setSetupProgress({ active: false, step: 1 });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True from the moment the vault is being created until the setup flow says it's finished. */
export function useSetupInProgress(): boolean {
  return useSyncExternalStore(subscribe, isSetupActive, () => false);
}
