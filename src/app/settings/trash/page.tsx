"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useVault } from "@/client/vault-provider";
import { Button, ConfirmDialog, EmptyState, Group, Row, Screen, ScreenHeader, Sheet, SkeletonRows, TopBar, useToast } from "@/components/ui";
import { DocumentRow } from "@/components/vault/document-row";
import { getSetting, trashed } from "@/lib/documents";
import { daysFromToday, plural } from "@/lib/format";
import type { IndexEntry } from "@/schemas/index";

const DAY = 86_400_000;

/** "Deletes in 12 days". With no automatic clean-up, says how long it's been here instead. */
function fate(entry: IndexEntry, retentionDays: number | null): string {
  if (!entry.trashedAt) return "In trash";
  if (retentionDays === null) {
    const ago = -daysFromToday(entry.trashedAt);
    return ago <= 0 ? "Moved here today" : `Moved here ${plural(ago, "day")} ago`;
  }
  const left = daysFromToday(new Date(Date.parse(entry.trashedAt) + retentionDays * DAY).toISOString());
  if (left <= 0) return "Deletes soon";
  return left === 1 ? "Deletes tomorrow" : `Deletes in ${left} days`;
}

export default function TrashPage() {
  const { state, rpc } = useVault();
  const { toast } = useToast();
  const index = state.index;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<IndexEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const items = useMemo(() => (index ? trashed(index) : []), [index]);
  const retention = index ? getSetting<number | null>(index, "trashRetentionDays", 30) : 30;
  const selected = items.find((e) => e.id === selectedId) ?? null;
  const isAdmin = state.role === "admin";

  const restore = async (entry: IndexEntry) => {
    setSelectedId(null);
    try {
      await rpc.restore(entry.id);
      toast({ message: `Restored ${entry.name}`, action: { label: "Undo", onAction: () => void rpc.trash(entry.id) } });
    } catch {
      toast({ message: `Couldn't restore ${entry.name}. Try again in a moment.` });
    }
  };

  const deleteForGood = async () => {
    if (!confirming) return;
    setDeleting(true);
    try {
      await rpc.deletePermanently(confirming.id);
      toast({ message: `Removed ${confirming.name} from your vault` });
      setConfirming(null);
    } catch {
      toast({ message: `Couldn't delete ${confirming.name}. Try again in a moment.` });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Screen>
      <div>
        <TopBar backLabel="Settings" backHref="/settings" />
        <ScreenHeader title="Trash" size="title">
          {retention === null
            ? "Documents here stay until someone deletes them permanently."
            : `Documents here are removed from your vault after ${plural(retention, "day")}.`}
        </ScreenHeader>
      </div>

      {!index ? (
        <SkeletonRows count={3} />
      ) : items.length === 0 ? (
        <EmptyState icon={Trash2} message="Trash is empty." />
      ) : (
        <Group>
          {items.map((entry) => (
            <DocumentRow key={entry.id} entry={entry} index={index} description={fate(entry, retention)} trailing={null} chevron onClick={() => setSelectedId(entry.id)} />
          ))}
        </Group>
      )}

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => { if (!open) setSelectedId(null); }}
        title={selected?.name ?? ""}
        description={selected ? fate(selected, retention) : undefined}
        showDescription
      >
        {selected && (
          <>
            <Button size="lg" icon={RotateCcw} onClick={() => void restore(selected)}>Restore</Button>
            {/* Removing files from the store is the admin's (§21.1). For everyone else the row isn't there, rather than there and dead. */}
            {isAdmin && (
              <Group>
                <Row
                  danger
                  icon={Trash2}
                  label="Delete permanently"
                  onClick={() => {
                    setConfirming(selected);
                    setSelectedId(null);
                  }}
                />
              </Group>
            )}
          </>
        )}
      </Sheet>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => { if (!open && !deleting) setConfirming(null); }}
        title={`Delete ${confirming?.name ?? "this document"} permanently?`}
        // §7.5: removed, never "erased". The app controls what it references, not what a provider still stores.
        body="It will be removed from your vault. Older copies may remain in version history and in backups for a time."
        confirmLabel="Delete permanently"
        onConfirm={() => void deleteForGood()}
        loading={deleting}
        loadingLabel="Deleting…"
      />
    </Screen>
  );
}
