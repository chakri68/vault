import { Circle, CircleCheck, Clock, TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/ui";
import { daysFromToday } from "@/lib/format";

export type BackupHealth = "never" | "failed" | "stale" | "healthy";

export function backupHealth(lastBackup?: { at: string; verified: boolean }): BackupHealth {
  if (!lastBackup) return "never";
  if (!lastBackup.verified) return "failed";
  return -daysFromToday(lastBackup.at) > 30 ? "stale" : "healthy";
}

/** §27.6 states. An icon and a word, never the colour alone. */
export function BackupPill({ lastBackup }: { lastBackup?: { at: string; verified: boolean } }) {
  switch (backupHealth(lastBackup)) {
    case "never": return <StatusPill tone="neutral" icon={Circle}>Never backed up</StatusPill>;
    case "failed": return <StatusPill tone="danger" icon={TriangleAlert}>Failed</StatusPill>;
    case "stale": return <StatusPill tone="warn" icon={Clock}>Stale · {-daysFromToday(lastBackup!.at)} days ago</StatusPill>;
    case "healthy": return <StatusPill tone="good" icon={CircleCheck}>Healthy</StatusPill>;
  }
}
