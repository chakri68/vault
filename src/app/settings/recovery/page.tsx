"use client";

import { useState } from "react";
import { useVault } from "@/client/vault-provider";
import { RecoveryCodeConfirm } from "@/components/settings/recovery-code-flow";
import { Banner, Button, Screen, ScreenHeader, TopBar, useToast } from "@/components/ui";

export default function RecoveryPage() {
  const { state, rpc } = useVault();
  const { toast } = useToast();
  const [code, setCode] = useState<{ groups: string[]; formatted: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const admin = state.role === "admin";

  const begin = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      setCode(await rpc.beginNewRecoveryCode());
    } catch {
      setProblem("That didn't work. Check your internet connection and try again.");
    }
    setBusy(false);
  };

  if (code) {
    return (
      <Screen gap="md">
        <div className="print:hidden"><TopBar backLabel="Cancel" onBack={() => setCode(null)} /></div>
        <ScreenHeader title="Write down your new recovery code" size="title">
          The old code keeps working until you confirm this one. After that, only this one does.
        </ScreenHeader>
        {problem && <Banner tone="danger" title="The new code wasn't saved">{problem}</Banner>}
        <RecoveryCodeConfirm
          groups={code.groups}
          formatted={code.formatted}
          where={state.config?.storage.location ?? "your storage"}
          check={(answers) => rpc.checkRecoveryGroups(answers)}
          onConfirmed={async () => {
            try {
              await rpc.commitNewRecoveryCode();
              setCode(null);
              toast({ message: "New recovery code saved. The old one no longer works." });
            } catch {
              setProblem("The old code still works. Check your internet connection and try again.");
            }
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen gap="lg">
      <TopBar backLabel="Settings" backHref="/settings" />
      <ScreenHeader title="Recovery code" size="title">
        If the family password is forgotten and no phone can unlock, the recovery code is the only way back in. It was shown once, when the vault was made, and it isn&apos;t kept anywhere, so it can&apos;t be shown again.
      </ScreenHeader>
      <p className="text-callout text-ink-2">
        If you can&apos;t find the paper it&apos;s written on, make a new code now, while you can still get in. The old code stops working.
      </p>
      {problem && <Banner tone="danger" title="Couldn't start">{problem}</Banner>}
      {admin ? (
        <div className="mt-auto"><Button size="lg" loading={busy} loadingLabel="Making a code…" onClick={() => void begin()}>Make a new recovery code</Button></div>
      ) : (
        <Banner tone="info" title="Ask the person who manages the vault">
          Replacing the recovery code is done from a device that manages the vault.
        </Banner>
      )}
    </Screen>
  );
}
