"use client";

import { formatDate } from "@/lib/format";

export interface RecoveryKitInfo {
  groups: readonly string[];
  /** where the app is reached: location.origin */
  appUrl: string;
  storage: { provider?: string; location?: string };
  madeOn: string;
}

const HOW_TO_RECOVER = [
  "Open the app address above on any phone or computer.",
  "On the lock screen, choose “Can’t get in?”, then “Use the recovery code”.",
  "Type the 8 groups exactly as written. The code never uses the letters O, I, L or U: a round shape is always zero, and a stroke is always one.",
  "Choose a new family password when asked, and tell the family.",
];

const IF_APP_GONE =
  "The vault’s files are still in the storage named above, and in any backups you made. Put the Family Vault app online again, point it at those files, and open them with this code.";

const KEEP_SAFE =
  "Keep this page with your passports. Anyone who has it can open the vault. Without this code and without the family password, nobody can open the vault again. Not whoever runs the site, not anyone.";

function storageLine(storage: RecoveryKitInfo["storage"]): string {
  return [storage.provider, storage.location].filter(Boolean).join(": ") || "Ask whoever set up the vault";
}

/** The same kit as plain text, for "Save". */
export function recoveryKitText(kit: RecoveryKitInfo): string {
  const code = [kit.groups.slice(0, 4), kit.groups.slice(4)]
    .map((row, r) => row.map((g, i) => `${r * 4 + i + 1}  ${g}`).join("     "))
    .join("\n  ");
  return [
    "FAMILY VAULT: RECOVERY KIT",
    `Made on ${formatDate(kit.madeOn)}`,
    "",
    "RECOVERY CODE",
    `  ${code}`,
    "",
    "WHERE THE VAULT LIVES",
    `  App:      ${kit.appUrl}`,
    `  Storage:  ${storageLine(kit.storage)}`,
    "",
    "IF NOBODY CAN GET IN",
    ...HOW_TO_RECOVER.map((line, i) => `  ${i + 1}. ${line}`),
    "",
    "IF THE APP ITSELF IS GONE",
    `  ${IF_APP_GONE}`,
    "",
    KEEP_SAFE,
    "",
  ].join("\n");
}

export function downloadRecoveryKit(kit: RecoveryKitInfo): void {
  const url = URL.createObjectURL(new Blob([recoveryKitText(kit)], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "family-vault-recovery-kit.txt";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * §20.2: one printable page. Invisible on screen, and the only thing on paper
 * (the screens around it are print:hidden). Black on white whatever the theme:
 * browsers don't print backgrounds, so dark mode's light ink would vanish.
 */
export function RecoveryKitPrint({ kit }: { kit: RecoveryKitInfo }) {
  return (
    <section aria-hidden className="hidden p-10 font-sans text-black print:block">
      <h1 className="text-title">Family Vault: recovery kit</h1>
      <p className="mt-1 text-callout">Made on {formatDate(kit.madeOn)}</p>

      <h2 className="mt-8 text-heading">Recovery code</h2>
      <ol className="mt-3 grid grid-cols-4 gap-x-6 gap-y-4 rounded-lg border border-black p-5">
        {kit.groups.map((group, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="tabular text-footnote">{i + 1}</span>
            <span className="font-mono text-[1.375rem] leading-8 font-semibold tracking-[0.1em]">{group}</span>
          </li>
        ))}
      </ol>

      <h2 className="mt-8 text-heading">Where the vault lives</h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
        <dt className="font-semibold">App</dt>
        <dd className="break-all">{kit.appUrl}</dd>
        <dt className="font-semibold">Storage</dt>
        <dd className="break-all">{storageLine(kit.storage)}</dd>
      </dl>

      <h2 className="mt-8 text-heading">If nobody can get in</h2>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-6 text-body">
        {HOW_TO_RECOVER.map((line) => <li key={line}>{line}</li>)}
      </ol>

      <h2 className="mt-8 text-heading">If the app itself is gone</h2>
      <p className="mt-2 text-body">{IF_APP_GONE}</p>

      <p className="mt-8 border-t border-black pt-4 text-body font-semibold">{KEEP_SAFE}</p>
    </section>
  );
}
