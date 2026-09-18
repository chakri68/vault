"use client";

import { CloudOff } from "lucide-react";
import { useState } from "react";
import { useVault } from "@/client/vault-provider";
import { AppMark, Banner, Button } from "@/components/ui";
import { AuthScreen, WorkingLine } from "./auth-screen";

/**
 * Two ways to be stuck before the lock screen: the vault's storage isn't
 * answering (or was never configured), or this device has no network and has
 * never opened the vault, so there's nothing local to open either.
 */
export function StorageProblem() {
  const { state, rpc } = useVault();
  const [busy, setBusy] = useState(false);
  const unreachable = state.phase === "unreachable";
  const storage = state.config?.storage;

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    await rpc.loadConfig().catch(() => {});
    setBusy(false);
  };

  return (
    <AuthScreen
      actions={
        <>
          <Button size="lg" loading={busy} loadingLabel="Checking…" onClick={() => void retry()}>Try again</Button>
          <WorkingLine active={busy} label="Checking" />
        </>
      }
    >
      <div className="flex flex-col items-start">
        <AppMark />
        <h1 className="mt-5.5 text-display">Family Vault</h1>
      </div>

      {unreachable ? (
        <Banner tone="info" icon={CloudOff} title="This phone needs internet the first time">
          It hasn&rsquo;t opened the vault before, so it has to reach it once. Connect, then try again. After that, documents kept on this phone open without internet.
        </Banner>
      ) : storage?.missing?.length ? (
        <Banner tone="warn" title="Storage isn't set up yet">
          <p>Whoever put this site online still needs to tell it where to keep the vault. These settings are missing on the server:</p>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-callout text-ink">
            {storage.missing.map((name) => <li key={name} className="break-all">{name}</li>)}
          </ul>
        </Banner>
      ) : (
        <Banner tone="danger" title="The vault's storage isn't answering">
          {storage?.problem ? `${capitalise(storage.problem)}. ` : ""}
          Your documents are still where they were; this site just can&rsquo;t reach them right now. Try again in a minute.
        </Banner>
      )}
    </AuthScreen>
  );
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replace(/\.$/, "");
