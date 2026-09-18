"use client";

import { Download, Printer } from "lucide-react";
import { useState } from "react";
import { useVault } from "@/client/vault-provider";
import { Button, Field, MonoInput, RecoveryCodeGrid } from "@/components/ui";
import { AuthHeading, AuthScreen, InlineError, WorkingLine } from "./auth-screen";
import { type RecoveryKitInfo, RecoveryKitPrint, downloadRecoveryKit } from "./recovery-kit";

interface Props {
  bar: React.ReactNode;
  kit: RecoveryKitInfo;
  /** the two groups to ask back, 0-based, chosen once when the code was made */
  ask: [number, number];
  /** creates the vault; resolves to an error message, or null when it worked */
  onConfirmed: () => Promise<string | null>;
}

/**
 * §20.1. The one screen with no way around it: no skip, no "remind me later".
 * The vault isn't created until two groups of the code have been typed back —
 * two, because one group checks four characters and not the handwriting.
 */
export function SetupRecoveryStep({ bar, kit, ask, onConfirmed }: Props) {
  const { rpc } = useVault();
  const [answers, setAnswers] = useState<[string, string]>(["", ""]);
  const [errors, setErrors] = useState<[string | undefined, string | undefined]>([undefined, undefined]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const setAnswer = (slot: 0 | 1, value: string) => {
    setAnswers((a) => (slot === 0 ? [value, a[1]] : [a[0], value]));
    setErrors((e) => (slot === 0 ? [undefined, e[1]] : [e[0], undefined]));
  };

  const confirm = async () => {
    if (busy) return;
    setFailure(null);
    const empty = answers.map((a, i) => (a.length === 0 ? `Type group ${ask[i] + 1} from what you wrote down.` : undefined));
    if (empty.some(Boolean)) return setErrors([empty[0], empty[1]]);

    setBusy(true);
    try {
      const ok = await rpc.checkRecoveryGroups([
        { group: ask[0], value: answers[0] },
        { group: ask[1], value: answers[1] },
      ]);
      if (!ok[0] || !ok[1]) {
        setErrors([
          ok[0] ? undefined : `That doesn't match group ${ask[0] + 1}. Check what you wrote.`,
          ok[1] ? undefined : `That doesn't match group ${ask[1] + 1}. Check what you wrote.`,
        ]);
        return;
      }
      setFailure(await onConfirmed());
    } catch {
      setFailure("Something went wrong checking the code. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AuthScreen
        onSubmit={() => void confirm()}
        bar={bar}
        actions={
          <>
            {failure && <InlineError>{failure}</InlineError>}
            <Button type="submit" size="lg" loading={busy} loadingLabel="Creating your vault…">I&rsquo;ve written it down</Button>
            <WorkingLine active={busy} label="Creating your vault" />
          </>
        }
      >
        <AuthHeading title="Write down your recovery code">
          <p>If the family password is forgotten and no phone can unlock, this is the only way back in. Keep it with your passports.</p>
        </AuthHeading>

        <RecoveryCodeGrid groups={kit.groups} />

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2.5">
          <Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print</Button>
          <Button variant="secondary" icon={Download} onClick={() => downloadRecoveryKit(kit)}>Save</Button>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-callout text-ink-2">Now check it. Type these two groups from what you wrote:</p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] items-start gap-2.5">
            {([0, 1] as const).map((slot) => (
              <Field key={slot} label={`Group ${ask[slot] + 1}`} error={errors[slot]}>
                <MonoInput
                  value={answers[slot]}
                  onValueChange={(v) => setAnswer(slot, v)}
                  maxLength={4}
                  placeholder="····"
                  enterKeyHint={slot === 0 ? "next" : "done"}
                  readOnly={busy}
                />
              </Field>
            ))}
          </div>
        </div>
      </AuthScreen>
      <RecoveryKitPrint kit={kit} />
    </>
  );
}
