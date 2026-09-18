"use client";

import { CircleCheck, Cloud, Download, FileArchive, FolderOpen, HardDrive, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { ensureWritable, folderBackupSupported, pickBackupFolder, savedBackupFolder } from "@/client/folder-handle";
import { useVault } from "@/client/vault-provider";
import { BackupPill, backupHealth } from "@/components/settings/backup-pill";
import {
  Banner, Button, Group, GroupLabel, Icon, ProgressBar, Row, Screen, ScreenHeader, Section, SegmentedControl, StatusPill,
  TopBar, useToast,
} from "@/components/ui";
import { formatRelative, plural } from "@/lib/format";

type Run =
  | { kind: "idle" }
  | { kind: "running"; label: string; value?: number }
  | { kind: "failed"; problems: string[] };

export default function BackupsPage() {
  const { state, rpc, online } = useVault();
  const { toast } = useToast();
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const supported = folderBackupSupported();
  const last = state.prefs.lastBackup;
  const exported = state.prefs.lastExport;
  const health = backupHealth(last);
  const primaryOk = !state.sync?.problem || state.sync.problem === "offline";
  // A downloaded file counts only while it's fresh, and only on the family's word that they kept it.
  const copies = (primaryOk ? 1 : 0) + (health === "healthy" || backupHealth(exported) === "healthy" ? 1 : 0);

  useEffect(() => { void savedBackupFolder().then(setFolder); }, []);

  const backUp = async (target: FileSystemDirectoryHandle | null) => {
    const handle = target ?? (await pickBackupFolder());
    if (!handle) return;
    setFolder(handle);
    if (!(await ensureWritable(handle))) return setRun({ kind: "failed", problems: ["The browser wasn't allowed to write to that folder."] });
    setRun({ kind: "running", label: "Getting ready…" });
    try {
      const result = await rpc.backupToFolder(handle, (done, total, phase) =>
        setRun({ kind: "running", label: phase === "copying" ? "Copying your documents…" : "Checking every file…", value: Math.round((done / Math.max(total, 1)) * 100) }));
      if (result.verified) {
        setRun({ kind: "idle" });
        toast({ message: `Backed up and checked ${plural(result.documents, "document")}` });
      } else setRun({ kind: "failed", problems: result.problems });
    } catch {
      setRun({ kind: "failed", problems: ["The backup didn't finish. Your vault is fine; nothing was changed in it."] });
    }
  };

  const download = async () => {
    setRun({ kind: "running", label: "Gathering your documents…" });
    try {
      const archive = await rpc.exportArchive((done, total) =>
        setRun({ kind: "running", label: "Gathering your documents…", value: Math.round((done / Math.max(total, 1)) * 100) }));
      if (!archive.verified) return setRun({ kind: "failed", problems: archive.problems });
      const url = URL.createObjectURL(new Blob(archive.chunks, { type: "application/zip" }));
      Object.assign(document.createElement("a"), { href: url, download: archive.fileName }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setRun({ kind: "idle" });
      toast({ message: `Backup file checked and saved: ${plural(archive.documents, "document")}. Now put it somewhere safe.` });
    } catch {
      setRun({ kind: "failed", problems: ["The backup file couldn't be made. Check your internet connection and try again."] });
    }
  };

  const running = run.kind === "running";

  return (
    <Screen gap="lg">
      <TopBar backLabel="Settings" backHref="/settings" />
      <ScreenHeader title="Backups" size="title" />

      <p className="flex items-start gap-2 text-label">
        <Icon icon={copies >= 2 ? CircleCheck : TriangleAlert} className={copies >= 2 ? "mt-0.5 size-5 text-good" : "mt-0.5 size-5 text-warn"} />
        <span>
          {copies >= 2
            ? health === "healthy" ? "2 independent copies available." : "2 copies, if the backup file you downloaded is somewhere safe."
            : copies === 1 ? "1 copy. If the storage account is lost, so are the documents." : "No healthy copy right now."}
        </span>
      </p>

      {!online && <Banner tone="info" title="You're offline">Backing up needs internet, to read the documents from your storage.</Banner>}
      {run.kind === "failed" && (
        <Banner tone="danger" title="The backup didn't complete" action={{ label: "Try again", onClick: () => void backUp(folder) }}>
          {run.problems[0] ?? "Something went wrong."} Your documents are safe in the vault.
        </Banner>
      )}
      {running && <ProgressBar label={run.label} value={run.value} />}

      <Section>
        <GroupLabel>Where your documents are</GroupLabel>
        <Group>
          <Row
            icon={Cloud}
            label={`${state.config?.storage.provider ?? "Primary storage"}`}
            description={state.config?.storage.versioning ? "Primary storage · keeps older versions" : "Primary storage"}
            trailing={primaryOk
              ? <StatusPill tone="good" icon={CircleCheck}>Healthy</StatusPill>
              : <StatusPill tone="danger" icon={TriangleAlert}>Needs attention</StatusPill>}
          />
          <Row
            icon={FileArchive}
            label="Backup file"
            description={exported ? `${plural(exported.documents, "document")} · Downloaded ${formatRelative(exported.at)}` : "A .zip to keep in Google Drive, on a USB stick, anywhere"}
            trailing={<BackupPill lastBackup={exported} />}
          />
          <Row
            icon={HardDrive}
            label={folder ? folder.name : "A folder or drive"}
            description={last ? `${plural(last.documents, "document")} · Checked ${formatRelative(last.at)}` : supported ? "An external drive, or a folder your computer syncs" : "Not available in this browser"}
            trailing={<BackupPill lastBackup={last} />}
          />
        </Group>
      </Section>

      {supported && folder && (
        <Section>
          <GroupLabel>Back up to the folder</GroupLabel>
          <SegmentedControl
            aria-label="Back up to the folder" fullWidth value={state.prefs.backupEvery}
            onValueChange={(v) => void rpc.setPrefs({ backupEvery: v })}
            options={[
              { value: "change", label: "After changes" }, { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" }, { value: "manual", label: "Manual" },
            ]}
          />
          <p className="px-1 pt-2 text-callout text-ink-3">
            Backups run while Family Vault is open on this computer, and only while the browser still has permission to the folder. If this says Stale, open the app here and press Back up now.
          </p>
        </Section>
      )}

      <Section>
        <GroupLabel>Make a copy</GroupLabel>
        <Group>
          {supported && folder && <Row icon={FolderOpen} label="Choose a different folder" onClick={() => void backUp(null)} chevron={false} />}
          <Row
            icon={Download}
            label="Download a backup file"
            description="One .zip with everything in it, still locked. Upload it to Google Drive, or keep it on a drive."
            onClick={() => (running ? undefined : void download())}
            chevron={false}
          />
        </Group>
        <p className="px-1 pt-2 text-callout text-ink-3">
          A backup is an exact copy of what&apos;s in your storage: locked files with meaningless names. It&apos;s safe to keep anywhere, because it opens with the family password or the recovery code and nothing else. To use it, choose &ldquo;Restore from a backup&rdquo; when setting the vault up again.
        </p>
      </Section>

      {supported && (
        <div className="mt-auto">
          <Button variant="secondary" size="lg" loading={running} loadingLabel="Backing up…" onClick={() => void backUp(folder)}>
            {folder ? "Back up now" : "Choose a folder and back up"}
          </Button>
        </div>
      )}
    </Screen>
  );
}
