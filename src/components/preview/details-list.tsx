"use client";

import { useEffect, useState } from "react";
import { Availability, Button, Group, GroupLabel, KeyValueRow, Section } from "@/components/ui";
import { profileName } from "@/lib/documents";
import { formatBytes, formatDate, formatDistance, formatDocumentNumber, maskNumber } from "@/lib/format";
import type { IndexEntry, VaultIndex } from "@/schemas/index";

const REMASK_MS = 30_000;

/**
 * Masked by default: you're usually at a counter with someone standing behind
 * you. "Show" lasts 30 seconds, or until the app leaves the screen.
 */
function DocumentNumberRow({ value }: { value: string }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), REMASK_MS);
    const hide = () => { if (document.visibilityState === "hidden") setShown(false); };
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [shown]);

  return (
    <KeyValueRow
      label="Document number"
      mono
      value={shown
        ? <span className="select-text">{formatDocumentNumber(value)}</span>
        : <span aria-label="Hidden">{maskNumber(value)}</span>}
      action={
        <Button variant="text" size="sm" aria-pressed={shown} onClick={() => setShown((s) => !s)}
          aria-label={shown ? "Hide document number" : "Show document number"}>
          {shown ? "Hide" : "Show"}
        </Button>
      }
    />
  );
}

export function DetailsList({ index, entry, onDevice }: { index: VaultIndex; entry: IndexEntry; onDevice: boolean }) {
  const doc = entry.document;
  const by = entry.createdByProfileId ? profileName(index, entry.createdByProfileId) : null;
  return (
    <>
      <Section>
        <GroupLabel as="h2">Details</GroupLabel>
        <Group>
          {doc?.referenceNumber && <DocumentNumberRow value={doc.referenceNumber} />}
          {doc?.expiryDate && <KeyValueRow label="Expires" value={formatDate(doc.expiryDate)} hint={formatDistance(doc.expiryDate)} />}
          {doc?.issueDate && <KeyValueRow label="Issued" value={formatDate(doc.issueDate)} />}
          {doc?.issuer && <KeyValueRow label="Issued by" value={doc.issuer} />}
          {entry.tags.length > 0 && <KeyValueRow label="Tags" value={entry.tags.join(", ")} />}
          <KeyValueRow label="Added" value={formatDate(entry.createdAt)} hint={by ? `by ${by}` : undefined} />
          <KeyValueRow label="Size" value={formatBytes(entry.plaintextSize)} />
          <KeyValueRow label="Availability" value={<Availability onDevice={onDevice} className="text-label text-ink" />} />
        </Group>
      </Section>
      {entry.note && (
        <Section>
          <GroupLabel as="h2">Notes</GroupLabel>
          <Group>
            <p className="px-4 py-3.5 text-body whitespace-pre-wrap break-words select-text">{entry.note}</p>
          </Group>
        </Section>
      )}
    </>
  );
}
