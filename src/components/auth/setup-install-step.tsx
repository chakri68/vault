"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { detectPlatform } from "@/client/passkey";
import { Button, Group, Row } from "@/components/ui";
import { AuthHeading, AuthScreen } from "./auth-screen";
import { promptInstall, useCanInstall } from "./install-prompt";

/**
 * Last stop. Where the browser can install with one tap, offer that; on iPhone,
 * say where Add to Home Screen is; anywhere else, point at the browser's menu.
 * Never required: "Done" always works.
 */
export function SetupInstallStep({ onDone }: { onDone: () => void }) {
  const canInstall = useCanInstall();
  const [platform] = useState(() => detectPlatform());
  const [busy, setBusy] = useState(false);
  const ios = platform === "iphone" || platform === "ipad";

  const install = async () => {
    setBusy(true);
    await promptInstall().catch(() => false);
    setBusy(false);
    onDone(); // installed or not, setup is finished
  };

  return (
    <AuthScreen
      actions={
        canInstall ? (
          <>
            <Button size="lg" icon={Download} loading={busy} loadingLabel="Installing…" onClick={() => void install()}>Install Family Vault</Button>
            <Button variant="text" className="self-center" onClick={onDone}>Not now</Button>
          </>
        ) : (
          <Button size="lg" onClick={onDone}>Done</Button>
        )
      }
    >
      <AuthHeading title="Put Family Vault on your home screen">
        <p>It opens like any other app, and it&rsquo;s there when you&rsquo;re standing at a counter. It still starts locked, every time.</p>
      </AuthHeading>

      {!canInstall && ios && (
        <Group>
          <Row label="1. Tap the Share button" description="It's in Safari's toolbar: a square with an arrow pointing up." />
          <Row label="2. Choose Add to Home Screen" description="You may need to scroll down the list to find it." />
          <Row label="3. Tap Add" />
        </Group>
      )}
      {!canInstall && !ios && (
        <p className="max-w-[65ch] text-callout text-ink-2">
          Look in your browser&rsquo;s menu for <span className="font-semibold text-ink">Install</span> or{" "}
          <span className="font-semibold text-ink">Add to Home screen</span>. If it isn&rsquo;t there, a bookmark works too.
        </p>
      )}
    </AuthScreen>
  );
}
