"use client";

import { CircleCheck, FileArchive, FolderOpen } from "lucide-react";
import { useRef, useState } from "react";
import { folderBackupSupported } from "@/client/folder-handle";
import { useVault } from "@/client/vault-provider";
import {
  Banner, Button, Field, Group, PasswordField, ProgressBar, Row, SegmentedControl, TextInput, TopBar,
} from "@/components/ui";
import { formatDate, plural } from "@/lib/format";
import { AuthHeading, AuthScreen, InlineError } from "./auth-screen";
import { endSetup, setSetupProgress } from "./setup-state";

type Found = { createdAt: string; files: number; hasPassword: boolean; hasRecoveryCode: boolean };
type Done = { documents: number; problems: string[]; needsNewPassword: boolean; needsNewRecoveryCode: boolean };

/**
 * §28: bring a vault back from a backup into an empty store. The backup is
 * opened on this device with the family password or the recovery code; only
 * then is anything created on the server, and what's uploaded is the backup's
 * own locked files, byte for byte.
 */
export function RestoreFlow({ onBack }: { onBack: () => void }) {
  const { state, rpc } = useVault();
  const picker = useRef<HTMLInputElement>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [kind, setKind] = useState<"password" | "code">("password");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<number | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const inspect = async (source: { archive: Uint8Array<ArrayBuffer> } | { folder: FileSystemDirectoryHandle }) => {
    setError(undefined);
    const result = await rpc.inspectBackup(source);
    if (!result.ok) return setError("That doesn't look like a Family Vault backup. Choose the backup file, or the folder you backed up to.");
    setFound(result);
    setKind(result.hasPassword ? "password" : "code");
  };

  const chooseFolder = async () => {
    try {
      const pick = (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      await inspect({ folder: await pick({ mode: "read" }) });
    } catch { /* cancelled */ }
  };

  const restore = async () => {
    if (!secret.trim()) return setError(kind === "password" ? "Enter the family password first." : "Enter the recovery code first.");
    setError(undefined);
    setProgress(0);
    // creating the vault flips the app to unlocked; this keeps the restore on screen until it's finished
    setSetupProgress({ active: true, step: 1 });
    const result = await rpc.restoreBackup(
      kind === "password" ? { password: secret } : { recoveryCode: secret },
      token || undefined,
      (d, t) => setProgress(Math.round((d / Math.max(t, 1)) * 100)),
    );
    setProgress(null);
    if (result.ok) return setDone(result);
    endSetup();
    setError(
      result.reason === "wrong" ? (kind === "password" ? "That password doesn't open this backup. Check caps lock and try again." : "That code doesn't open this backup. Check each group against what you wrote down.")
      : result.reason === "invalid-code" ? "That code has a typo somewhere. Check each group against what you wrote down."
      : result.detail === "setup-token" ? "The setup code isn't right. It's the one set by whoever put this site online."
      : result.detail === "already-initialized" ? "There's already a vault here, so a backup can't be restored over it."
      : "The restore didn't finish. Check your internet connection and try again.",
    );
  };

  if (done) {
    return (
      <AuthScreen actions={<Button size="lg" onClick={() => endSetup()}>Open the vault</Button>}>
        <AuthHeading title="Your vault is back">
          <p>{plural(done.documents, "document")} restored and checked.</p>
        </AuthHeading>
        {done.problems.length > 0 && (
          <Banner tone="warn" title="Not everything came back">{done.problems.join(" ")}</Banner>
        )}
        <Group>
          <Row icon={CircleCheck} label="Phones need adding again" description="Fingerprint and face unlock belong to the old site. Add each phone from Settings → Devices." />
          {done.needsNewRecoveryCode && <Row icon={CircleCheck} label="Make a new recovery code" description="The old code doesn't work here until you replace it. Settings → Recovery code." />}
          {done.needsNewPassword && <Row icon={CircleCheck} label="Choose a new family password" description="You'll be asked for one next." />}
        </Group>
      </AuthScreen>
    );
  }

  if (progress !== null) {
    return (
      <AuthScreen>
        <AuthHeading title="Restoring your vault"><p>Keep this page open. Nothing is unlocked along the way: the files go back exactly as they were saved.</p></AuthHeading>
        <ProgressBar label="Putting your documents back…" value={progress} />
      </AuthScreen>
    );
  }

  if (!found) {
    return (
      <AuthScreen bar={<TopBar backLabel="Back" onBack={onBack} />}>
        <AuthHeading title="Restore from a backup">
          <p>Use this when the vault&rsquo;s storage is gone and you have a backup. You&rsquo;ll need the family password or the recovery code.</p>
        </AuthHeading>
        {error && <Banner tone="danger" title="Couldn't read that">{error}</Banner>}
        <input
          ref={picker} type="file" accept=".zip,.fvault,application/zip,application/octet-stream" className="sr-only" tabIndex={-1} aria-label="Choose a backup file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) await inspect({ archive: new Uint8Array(await file.arrayBuffer()) });
          }}
        />
        <Group>
          <Row icon={FileArchive} label="Choose a backup file" description="The family-vault-backup .zip you downloaded" onClick={() => picker.current?.click()} chevron />
          {folderBackupSupported() && <Row icon={FolderOpen} label="Choose a backup folder" description="The folder or drive you backed up to" onClick={() => void chooseFolder()} chevron />}
        </Group>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      bar={<TopBar backLabel="Back" onBack={() => { setFound(null); setSecret(""); setError(undefined); }} />}
      onSubmit={() => void restore()}
      actions={<>{error && <InlineError>{error}</InlineError>}<Button type="submit" size="lg">Restore this backup</Button></>}
    >
      <AuthHeading title="Open the backup">
        <p>A vault made on {formatDate(found.createdAt)}, with {plural(found.files, "document")}. It will be restored into {state.config?.storage.provider ?? "your storage"}.</p>
      </AuthHeading>
      {found.hasPassword && found.hasRecoveryCode && (
        <SegmentedControl
          aria-label="Open it with" fullWidth value={kind}
          onValueChange={(v) => { setKind(v); setSecret(""); setError(undefined); }}
          options={[{ value: "password", label: "Family password" }, { value: "code", label: "Recovery code" }]}
        />
      )}
      {kind === "password" ? (
        <Field label="Family password"><PasswordField value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="current-password" /></Field>
      ) : (
        <Field label="Recovery code" helper="All eight groups. Spaces don't matter.">
          <TextInput value={secret} onChange={(e) => setSecret(e.target.value.toUpperCase())} autoComplete="off" autoCapitalize="characters" spellCheck={false} inputClassName="font-mono tracking-[0.06em]" />
        </Field>
      )}
      {state.config?.setupTokenRequired && (
        <Field label="Setup code" helper="Set by whoever put this site online.">
          <TextInput value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </Field>
      )}
    </AuthScreen>
  );
}
