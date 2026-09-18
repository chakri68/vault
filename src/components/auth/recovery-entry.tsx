"use client";

import { type ClipboardEvent, useRef, useState } from "react";
import { useVault } from "@/client/vault-provider";
import { Banner, Button, Field, MonoInput, TopBar } from "@/components/ui";
import { AuthHeading, AuthScreen, InlineError, WorkingLine, waitWords } from "./auth-screen";

const GROUPS = 8;
const GROUP_SIZE = 4;

/** What's pasted may carry spaces, dashes or line breaks from wherever it was kept. */
const clean = (text: string) => text.toUpperCase().replace(/[^0-9A-Z]/g, "");

/**
 * §5.1 path C. Deliberately a screen of its own, two taps from the lock screen:
 * the recovery code is the way back in when everything else is gone, never a
 * routine way to unlock.
 */
export function RecoveryEntry({ onBack }: { onBack: () => void }) {
  const { rpc } = useVault();
  const [groups, setGroups] = useState<string[]>(() => Array(GROUPS).fill(""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [firstTime, setFirstTime] = useState(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  const setGroup = (index: number, value: string) => {
    setError(null);
    setGroups((g) => g.map((x, i) => (i === index ? value : x)));
    if (value.length === GROUP_SIZE) inputs.current[index + 1]?.focus();
  };

  // the whole code pasted into any box fills every box
  const onPaste = (index: number, e: ClipboardEvent<HTMLInputElement>) => {
    const text = clean(e.clipboardData.getData("text"));
    if (text.length <= GROUP_SIZE) return;
    e.preventDefault();
    setError(null);
    const start = text.length >= GROUPS * GROUP_SIZE ? 0 : index;
    setGroups((g) => g.map((x, i) => (i < start ? x : text.slice((i - start) * GROUP_SIZE, (i - start + 1) * GROUP_SIZE) || x)));
    inputs.current[Math.min(GROUPS - 1, start + Math.ceil(text.length / GROUP_SIZE) - 1)]?.focus();
  };

  const submit = async () => {
    if (busy) return;
    const missing = groups.findIndex((g) => g.length < GROUP_SIZE);
    if (missing !== -1) {
      setError(`Group ${missing + 1} needs ${GROUP_SIZE} characters. Type it as it's written down.`);
      inputs.current[missing]?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setFirstTime(false);
    const result = await rpc.unlockWithRecoveryCode(groups.join("")).catch(() => ({ ok: false as const, reason: "server" as const, retryAfter: undefined }));
    if (result.ok) return; // the app opens; this screen is gone
    setBusy(false);
    switch (result.reason) {
      case "invalid-code":
        return setError("That code has a typo somewhere. Check each group against what you wrote down.");
      case "wrong":
        return setError("That code didn't open the vault. Check each group against what you wrote down.");
      case "rate-limited":
        return setError(`Too many tries. Wait ${waitWords(result.retryAfter)}, then try again.`);
      case "offline-first-time":
        return setFirstTime(true);
      case "key-changed":
        return setError("This vault's key changed unexpectedly. Don't carry on: ask whoever looks after the vault first.");
      default:
        return setError("The vault's storage didn't answer. Try again in a moment.");
    }
  };

  return (
    <AuthScreen
      onSubmit={() => void submit()}
      bar={<TopBar backLabel="Back" onBack={onBack} />}
      actions={
        <>
          {error && <InlineError>{error}</InlineError>}
          <Button type="submit" size="lg" loading={busy} loadingLabel="Unlocking…">Unlock with recovery code</Button>
          <WorkingLine active={busy} label="Unlocking" />
        </>
      }
    >
      <AuthHeading title="Enter your recovery code">
        <p>The 8 groups you wrote down when the vault was set up. The code never uses the letters O, I, L or U, so a round shape is always zero and a stroke is always one.</p>
      </AuthHeading>
      {firstTime && (
        <Banner tone="info" title="This phone needs internet first">
          It hasn&rsquo;t opened the vault before, so it has to reach it once. Connect, then try again.
        </Banner>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-x-2.5 gap-y-4">
        {groups.map((value, i) => (
          <Field key={i} label={`Group ${i + 1}`}>
            <MonoInput
              ref={(el) => { inputs.current[i] = el; }}
              value={value}
              onValueChange={(v) => setGroup(i, clean(v).slice(0, GROUP_SIZE))}
              onPaste={(e) => onPaste(i, e)}
              maxLength={GROUP_SIZE}
              inputMode="text"
              enterKeyHint={i === GROUPS - 1 ? "done" : "next"}
              placeholder="····"
              readOnly={busy}
            />
          </Field>
        ))}
      </div>
    </AuthScreen>
  );
}
