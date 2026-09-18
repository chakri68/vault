"use client";

import { Download, Printer } from "lucide-react";
import { useState } from "react";
import { Button, Field, MonoInput, RecoveryCodeGrid } from "@/components/ui";
import { formatDate } from "@/lib/format";

/** Two groups picked at random. One group checks four characters; two check that someone actually wrote it down. */
function pickTwo(): [number, number] {
  const a = Math.floor(Math.random() * 8);
  let b = Math.floor(Math.random() * 7);
  if (b >= a) b++;
  return a < b ? [a, b] : [b, a];
}

export function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
  a.click();
  URL.revokeObjectURL(url);
}

export function recoveryKitText(formatted: string, where: string): string {
  return [
    "FAMILY VAULT — RECOVERY CODE",
    "",
    formatted.split(" ").slice(0, 4).join("  "),
    formatted.split(" ").slice(4).join("  "),
    "",
    `Made on: ${formatDate(new Date().toISOString())}`,
    `Vault address: ${location.origin}`,
    `Documents are stored in: ${where}`,
    "",
    "Keep this with your passports. Anyone holding it can open the vault.",
    "",
    "To get back in: open the vault address, choose \"Can't get in?\", then \"Use the recovery code\".",
    "If the vault address is gone too: set the app up again from its public source, choose",
    "\"Restore from a backup\", pick your backup, and type this code.",
  ].join("\n");
}

/**
 * Show the code, make them type two groups back. Used when replacing the
 * recovery code from Settings. There is deliberately no way to skip the check.
 */
export function RecoveryCodeConfirm({
  groups, formatted, where, check, onConfirmed, confirmLabel = "I've written it down",
}: {
  groups: string[];
  formatted: string;
  where: string;
  check: (answers: Array<{ group: number; value: string }>) => Promise<boolean[]>;
  onConfirmed: () => Promise<void>;
  confirmLabel?: string;
}) {
  const [asked] = useState(pickTwo);
  const [values, setValues] = useState(["", ""]);
  const [errors, setErrors] = useState<Array<string | undefined>>([undefined, undefined]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const empty = values.map((v) => (v.length === 0 ? "Type this group from what you wrote down." : undefined));
    if (empty.some(Boolean)) return setErrors(empty);
    setBusy(true);
    const ok = await check(asked.map((group, i) => ({ group, value: values[i] })));
    if (ok.every(Boolean)) await onConfirmed();
    else setErrors(ok.map((good, i) => (good ? undefined : `That doesn't match group ${asked[i] + 1}. Check what you wrote.`)));
    setBusy(false);
  };

  return (
    <>
      <RecoveryCodeGrid groups={groups} />
      <div className="grid grid-cols-2 gap-2.5 print:hidden">
        <Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print</Button>
        <Button variant="secondary" icon={Download} onClick={() => downloadText("family-vault-recovery-code.txt", recoveryKitText(formatted, where))}>Save</Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2.5 print:hidden">
        {asked.map((group, i) => (
          <Field key={group} label={`Group ${group + 1}`} error={errors[i]}>
            <MonoInput
              value={values[i]} maxLength={4} autoComplete="off" placeholder="····"
              onValueChange={(v) => { setValues(values.map((x, j) => (j === i ? v : x))); setErrors(errors.map((x, j) => (j === i ? undefined : x))); }}
            />
          </Field>
        ))}
      </div>
      <div className="mt-auto print:hidden">
        <Button size="lg" loading={busy} loadingLabel="Checking…" onClick={() => void submit()}>{confirmLabel}</Button>
      </div>
    </>
  );
}
