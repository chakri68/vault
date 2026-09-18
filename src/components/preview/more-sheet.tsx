"use client";

import { FileText, FileUp, Pencil, Smartphone, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { detectPlatform } from "@/client/passkey";
import { useVault } from "@/client/vault-provider";
import { isProcessableImage, stripMetadata } from "@/compression/image-client";
import { detectHiddenDetails } from "@/compression/metadata";
import { Button, Field, Group, ProgressBar, Row, Sheet, TextInput, useToast } from "@/components/ui";
import { mimeTypeFor } from "@/components/upload/dates";
import { useFilePicker } from "@/components/upload/file-picker";
import { sizeAdvice, splitFileName } from "@/lib/documents";
import { formatBytes } from "@/lib/format";
import type { IndexEntry } from "@/schemas/index";

type Bytes = Uint8Array<ArrayBuffer>;

const deviceWord = () => {
  const p = detectPlatform();
  return p === "android" || p === "iphone" ? "phone" : p === "ipad" ? "iPad" : "computer";
};

/**
 * Everything that isn't Share or Download. Rows, with the one destructive
 * action in a group of its own at the bottom. Shred is deliberately not here:
 * two destructive verbs side by side is how the wrong one gets tapped.
 */
export function MoreSheet({ entry, open, onOpenChange }: {
  entry: IndexEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { state, rpc } = useVault();
  const { toast } = useToast();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(entry.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);

  const keepsEverything = state.prefs.keepEverythingOffline;
  const pinned = state.prefs.pins.includes(entry.id);
  const maxBytes = state.config?.maxObjectBytes ?? 50 * 1024 * 1024;

  const rename = async () => {
    const next = name.trim();
    if (!next) return setNameError("Give it a name, so you can find it later.");
    setRenaming(false);
    if (next === entry.name) return;
    const previous = entry.name;
    await rpc.updateMeta(entry.id, { name: next });
    toast({ message: `Renamed to ${next}`, action: { label: "Undo", onAction: () => void rpc.updateMeta(entry.id, { name: previous }) } });
  };

  const moveToTrash = async () => {
    onOpenChange(false);
    await rpc.trash(entry.id);
    router.replace("/");
    // undo beats confirm: trash is reversible, so nobody gets asked "are you sure?"
    toast({ message: `Moved ${entry.name} to trash`, action: { label: "Undo", onAction: () => void rpc.restore(entry.id) } });
  };

  /**
   * Content is never rewritten in place. A replacement is a new document that
   * carries this one's details, and the old one goes to the trash, where it can
   * still be had back.
   */
  const replaceWith = async (file: File) => {
    onOpenChange(false);
    const bytesIn = new Uint8Array(await file.arrayBuffer()) as Bytes;
    if (sizeAdvice(bytesIn.length, maxBytes) === "blocked") {
      return void toast({ message: `That file is too big to save. Files up to ${formatBytes(maxBytes)} fit.` });
    }
    setReplacing(true);
    try {
      let content = bytesIn;
      let { extension } = splitFileName(file.name);
      let mimeType = mimeTypeFor(file, extension);
      // same default as adding: a photo's location doesn't come along
      if (isProcessableImage(mimeType) && detectHiddenDetails(bytesIn).any) {
        ({ bytes: content, mimeType, extension } = await stripMetadata(bytesIn, mimeType));
      }
      const { ids } = await rpc.addDocuments([{
        content, mimeType, extension,
        meta: {
          name: entry.name, ownerProfileIds: entry.ownerProfileIds, category: entry.category, tags: entry.tags,
          note: entry.note, document: entry.document, temporary: entry.temporary, reminders: entry.reminders,
        },
      }]);
      const fresh = ids[0];
      await rpc.trash(entry.id);
      router.replace(`/doc?id=${fresh}`);
      toast({
        message: `Replaced the file for ${entry.name}. The old one is in the trash.`,
        action: {
          label: "Undo",
          onAction: () => {
            void rpc.restore(entry.id).then(() => rpc.trash(fresh));
            router.replace(`/doc?id=${entry.id}`);
          },
        },
      });
    } catch {
      toast({ message: "That didn't work, and nothing was changed. Try again, or add it as a new document." });
    } finally {
      setReplacing(false);
    }
  };

  const picker = useFilePicker({ label: "Choose the replacement file", onFiles: (files) => void replaceWith(files[0]) });

  return (
    <>
      {picker.input}
      <Sheet open={open} onOpenChange={onOpenChange} title={entry.name} description="More actions for this document.">
        <Group>
          <Row icon={Pencil} label="Rename" chevron={false}
            onClick={() => { onOpenChange(false); setName(entry.name); setNameError(null); setRenaming(true); }} />
          <Row icon={FileText} label="Edit details" chevron={false} href={`/doc/edit?id=${entry.id}`} onClick={() => onOpenChange(false)} />
          <Row icon={FileUp} label="Replace file" chevron={false} onClick={picker.open} />
          {keepsEverything ? (
            <Row icon={Smartphone} label={`Keep on this ${deviceWord()}`} description="Already on. Everything is kept for opening without internet." value="On" />
          ) : (
            <Row icon={Smartphone} label={`Keep on this ${deviceWord()}`} description="Opens without internet"
              checked={pinned} onCheckedChange={(v) => void rpc.setPinned(entry.id, v)} />
          )}
        </Group>
        <Group>
          <Row icon={Trash2} label="Move to trash" danger onClick={() => void moveToTrash()} />
        </Group>
      </Sheet>

      <Sheet open={renaming} onOpenChange={setRenaming} title="Rename">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
          <Field label="Name" error={nameError ?? undefined}>
            <TextInput value={name} onChange={(e) => { setName(e.target.value); setNameError(null); }} autoComplete="off" enterKeyHint="done" autoFocus />
          </Field>
          <Button size="lg" type="submit">Save name</Button>
        </form>
      </Sheet>

      <Sheet open={replacing} onOpenChange={() => {}} title="Replacing the file">
        <ProgressBar label="Encrypting and saving…" />
      </Sheet>
    </>
  );
}
