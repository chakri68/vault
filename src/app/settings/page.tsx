"use client";

import { FileText, HardDrive, KeyRound, Lock, ShieldCheck, Smartphone, Timer, Trash2, Users, Wrench } from "lucide-react";
import { useState } from "react";
import { useVault } from "@/client/vault-provider";
import { BackupPill } from "@/components/settings/backup-pill";
import { Button, Group, GroupLabel, Row, Screen, ScreenHeader, Section, SegmentedControl, Sheet } from "@/components/ui";
import { activeProfiles, getSetting, trashed } from "@/lib/documents";
import { formatBytes, plural } from "@/lib/format";

const LOCK_OPTIONS: Array<{ minutes: number | null; label: string }> = [
  { minutes: 1, label: "1 minute" }, { minutes: 5, label: "5 minutes" }, { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" }, { minutes: null, label: "While the app is open" },
];

const RETENTION = [
  { value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "never", label: "Never" },
];

export default function SettingsPage() {
  const { state, rpc, lock } = useVault();
  const [lockSheet, setLockSheet] = useState(false);
  const index = state.index;
  const prefs = state.prefs;
  const retention = index ? getSetting<number | null>(index, "trashRetentionDays", 30) : 30;
  const lockLabel = LOCK_OPTIONS.find((o) => o.minutes === prefs.lockAfterMinutes)?.label ?? `${prefs.lockAfterMinutes} minutes`;

  return (
    <Screen bottomBar gap="lg">
      <ScreenHeader title="Settings" />

      <Section>
        <GroupLabel>Family</GroupLabel>
        <Group>
          <Row icon={Users} label="People" value={index ? String(activeProfiles(index).length) : undefined} href="/settings/people" />
          <Row icon={Smartphone} label="Devices" description="Phones and computers that can open the vault" href="/settings/devices" />
        </Group>
      </Section>

      <Section>
        <GroupLabel>Keeping it safe</GroupLabel>
        <Group>
          <Row icon={KeyRound} label="Recovery code" description="The way back in if everything else is lost" href="/settings/recovery" />
          <Row icon={HardDrive} label="Backups" trailing={<BackupPill lastBackup={prefs.lastBackup} />} href="/settings/backups" chevron={false} />
          <Row icon={Timer} label="Lock after" value={lockLabel} onClick={() => setLockSheet(true)} chevron />
          <Row
            icon={Smartphone}
            label="Keep everything offline"
            description={`Uses ${formatBytes(state.cacheBytes)} on this device`}
            checked={prefs.keepEverythingOffline}
            onCheckedChange={(v) => void rpc.setPrefs({ keepEverythingOffline: v })}
          />
        </Group>
      </Section>

      <Section>
        <GroupLabel>Vault</GroupLabel>
        <Group>
          <Row icon={Trash2} label="Trash" value={index ? plural(trashed(index).length, "document") : undefined} href="/settings/trash" />
          <Row
            label="Keep trash for"
            description="After that, documents are removed from your vault"
            trailing={
              <SegmentedControl
                aria-label="Keep trash for"
                value={retention === null ? "never" : String(retention)}
                onValueChange={(v) => void rpc.setSetting("trashRetentionDays", v === "never" ? null : Number(v))}
                options={RETENTION}
              />
            }
          />
        </Group>
      </Section>

      <Section>
        <GroupLabel>Security</GroupLabel>
        <Group>
          <Row icon={ShieldCheck} label="Password and sign-in" href="/settings/security" />
          <Row icon={Wrench} label="Repair vault" description="Rebuild the list of documents from the files themselves" href="/settings/repair" />
          <Row icon={FileText} label="Technical details" href="/settings/technical" />
        </Group>
      </Section>

      <Button variant="secondary" size="lg" icon={Lock} onClick={() => void lock()}>Lock now</Button>

      <Sheet open={lockSheet} onOpenChange={setLockSheet} title="Lock after">
        <Group>
          {LOCK_OPTIONS.map((o) => (
            <Row
              key={o.label}
              label={o.label}
              value={o.minutes === prefs.lockAfterMinutes ? "Selected" : undefined}
              onClick={() => { void rpc.setPrefs({ lockAfterMinutes: o.minutes }); setLockSheet(false); }}
              chevron={false}
            />
          ))}
        </Group>
      </Sheet>
    </Screen>
  );
}
