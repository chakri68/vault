"use client";

import { useMemo } from "react";
import { useVault } from "@/client/vault-provider";
import { activeProfiles, forProfile, visibleEntries } from "@/lib/documents";

/**
 * The decrypted index, narrowed to what a list should show: active documents
 * that haven't expired, for whoever is picked in the people chips.
 *
 * The chips are a filter, not a gate. Nothing here hides a document from
 * anyone who can unlock the vault (§21.2); `all` is always one tap away.
 */
export function useDocs() {
  const { state } = useVault();
  const index = state.index;
  const all = useMemo(() => (index ? visibleEntries(index) : []), [index]);
  const profiles = useMemo(() => (index ? activeProfiles(index) : []), [index]);
  // a remembered profile that has since been removed falls back to everyone
  const wanted = state.prefs.activeProfileId;
  const activeProfileId = wanted && profiles.some((p) => p.id === wanted) ? wanted : null;
  const entries = useMemo(() => forProfile(all, activeProfileId), [all, activeProfileId]);
  return { index, all, entries, profiles, activeProfileId };
}
