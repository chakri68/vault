"use client";

import { FileText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { detectPlatform } from "@/client/passkey";
import type { NewDocumentInput } from "@/client/session-core";
import { useVault } from "@/client/vault-provider";
import {
  ImageDecodeError, type ProcessedImage, imageDimensions, isProcessableImage, optimiseImage, stripMetadata,
} from "@/compression/image-client";
import { type Detection, describeHiddenDetails, detectHiddenDetails } from "@/compression/metadata";
import { PreviewCard } from "@/components/preview/preview-card";
import { usePreviewUrl } from "@/components/preview/use-preview-url";
import {
  Banner, Button, type CatTint, Chip, ChipRow, Field, Group, GroupLabel, KeyValueRow, ProgressBar, Row, Screen,
  ScreenHeader, Section, SegmentedControl, TextInput, Tile, TopBar, categoryInfo, useToast,
} from "@/components/ui";
import { activeCategories, activeProfiles, sizeAdvice, splitFileName, suggestName } from "@/lib/documents";
import { formatBytes, formatDate, plural } from "@/lib/format";
import type { IndexEntry } from "@/schemas/index";
import { TEMPORARY_OPTIONS, type TemporaryChoice, dateInputToIso, kindLabel, mimeTypeFor, temporaryExpiry } from "./dates";
import { useFilePicker } from "./file-picker";
import { CategoryPicker, PeoplePicker } from "./meta-pickers";
import { onPendingFiles, peekEmptyShare, peekPendingFiles, takeEmptyShare, takePendingFiles } from "./pending-files";

type Bytes = Uint8Array<ArrayBuffer>;

interface Item {
  key: string;
  file: File;
  bytes: Bytes;
  mimeType: string;
  extension: string;
  detection: Detection | null;
  duplicate: IndexEntry | null;
  name: string;
  nameEdited: boolean;
}

interface Comparison {
  original: { width: number; height: number };
  result: ProcessedImage;
}

let keySeq = 0;

const whereWords = () => {
  const p = detectPlatform();
  return p === "android" || p === "iphone" ? "on your phone" : p === "ipad" ? "on your iPad" : "on this computer";
};

/**
 * §12: everything between picking a file and it being in the vault. The files
 * live in this component's memory and nowhere else; leaving the screen drops them.
 */
export function ReviewScreen() {
  const router = useRouter();
  const { state, rpc } = useVault();
  const { toast } = useToast();
  const index = state.index;
  const maxBytes = state.config?.maxObjectBytes ?? 50 * 1024 * 1024;

  // peek, don't take: the initialiser can run twice in development, and must give the same answer both times
  const [incoming, setIncoming] = useState<File[]>(() => peekPendingFiles());
  const [items, setItems] = useState<Item[]>([]);
  const [reading, setReading] = useState(() => peekPendingFiles().length > 0);
  // the share sheet brought them here, and the browser left the file behind
  const [emptyShare] = useState(() => peekEmptyShare());

  const [category, setCategory] = useState<string | undefined>();
  const [owners, setOwners] = useState<string[]>(() => (state.prefs.activeProfileId ? [state.prefs.activeProfileId] : []));
  const [expires, setExpires] = useState("");
  const [keep, setKeep] = useState<"forever" | "temporary">("forever");
  const [tempChoice, setTempChoice] = useState<TemporaryChoice>("24h");
  const [tempDate, setTempDate] = useState("");
  const [removeDetails, setRemoveDetails] = useState(true);
  const [duplicatesOk, setDuplicatesOk] = useState(false);
  const [largeOk, setLargeOk] = useState(false);
  const [maxQuality, setMaxQuality] = useState(false);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [optimised, setOptimised] = useState<ProcessedImage | null>(null);
  const [optimising, setOptimising] = useState(false);
  const [cannotProcess, setCannotProcess] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ label: string; value?: number } | null>(null);

  const categories = useMemo(() => (index ? activeCategories(index) : []), [index]);
  const profiles = useMemo(() => (index ? activeProfiles(index) : []), [index]);

  const suggest = useCallback((fileName: string, modified: number) => suggestName({
    fileName,
    categoryId: category,
    categoryName: categories.find((c) => c.id === category)?.name,
    person: profiles.find((p) => p.id === owners[0]),
    date: new Date(modified),
  }), [category, categories, profiles, owners]);

  // files that arrive while this screen is already open (a second drop) replace the batch
  useEffect(() => {
    takePendingFiles();
    takeEmptyShare();
    return onPendingFiles(() => {
      const next = takePendingFiles();
      if (next.length) {
        setReading(true);
        setIncoming(next);
      }
    });
  }, []);

  // read each file once: its bytes, what's hidden in it, and whether the vault already has it
  useEffect(() => {
    if (incoming.length === 0) return;
    let cancelled = false;
    void (async () => {
      const next: Item[] = [];
      for (const file of incoming) {
        const bytes = new Uint8Array(await file.arrayBuffer()) as Bytes;
        const { extension } = splitFileName(file.name);
        const mimeType = mimeTypeFor(file, extension);
        const detection = mimeType.startsWith("image/") ? detectHiddenDetails(bytes) : null;
        const duplicate = await rpc.findDuplicate(bytes).catch(() => null);
        next.push({
          key: `f${++keySeq}`, file, bytes, mimeType, extension, detection, duplicate,
          name: "", nameEdited: false,
        });
      }
      if (cancelled) return;
      setItems(next);
      setComparison(null);
      setOptimised(null);
      setCannotProcess(false);
      setDuplicatesOk(false);
      setLargeOk(false);
      setReading(false);
    })();
    return () => { cancelled = true; };
  }, [incoming, rpc]);

  // names follow the category and the person until someone types their own
  const nameOf = (it: Item) => (it.nameEdited ? it.name : suggest(it.file.name, it.file.lastModified));

  const single = items.length === 1 ? items[0] : null;

  // a thumbnail for a single picture; the URL is tracked, so locking revokes it
  const shown = single?.mimeType.startsWith("image/") ? (optimised ?? single) : null;
  const thumb = usePreviewUrl(shown?.bytes, shown?.mimeType);

  const picker = useFilePicker({
    label: "Choose a file", multiple: true,
    onFiles: (files) => { setReading(true); setIncoming(files); },
  });

  // ───────────────────────── derived ─────────────────────────

  const sizeOf = (it: Item) => (single && optimised ? optimised.bytes.length : it.bytes.length);
  const advice = single ? sizeAdvice(sizeOf(single), maxBytes) : "fine";
  const blocked = items.filter((it) => sizeAdvice(sizeOf(it), maxBytes) === "blocked");
  const duplicates = items.filter((it) => it.duplicate);
  const withDetails = items.filter((it) => it.detection?.any && isProcessableImage(it.mimeType));
  const detailWords = [...new Set(withDetails.flatMap((it) => describeHiddenDetails(it.detection!.details)))];
  const canShrink = !!single && isProcessableImage(single.mimeType) && !optimised && !cannotProcess;

  const setName = (key: string, name: string) => {
    setNameError(null);
    setItems((list) => list.map((it) => (it.key === key ? { ...it, name, nameEdited: true } : it)));
  };

  const shrink = async (maximumQuality = maxQuality) => {
    if (!single) return;
    setOptimising(true);
    setProblem(null);
    try {
      const [original, result] = await Promise.all([
        comparison?.original ?? imageDimensions(single.bytes, single.mimeType),
        optimiseImage(single.bytes, single.mimeType, { maximumQuality }),
      ]);
      setComparison({ original, result });
    } catch (e) {
      if (e instanceof ImageDecodeError) setCannotProcess(true);
      else setProblem("That didn't work. You can still save the original.");
    } finally {
      setOptimising(false);
    }
  };

  // ───────────────────────── save ─────────────────────────

  const save = async () => {
    setProblem(null);
    const unnamed = items.find((it) => !nameOf(it).trim());
    if (unnamed) {
      setNameError("Give it a name, so you can find it later.");
      if (!single) setProblem("One of the documents has no name yet. Give each one a name, so you can find it later.");
      return;
    }
    if (blocked.length) {
      return setProblem(single
        ? `This file is too big to save. Files up to ${formatBytes(maxBytes)} fit. Make it smaller first.`
        : `${plural(blocked.length, "file is", "files are")} too big to save. Remove ${blocked.length === 1 ? "it" : "them"} from the list first.`);
    }
    if (duplicates.length && !duplicatesOk) {
      return setProblem(single
        ? "This file is already in your vault. Choose “Upload anyway” above to save a second copy."
        : "Some of these are already in your vault. Choose “Skip those” or “Upload anyway” above.");
    }
    if (single && advice === "confirm" && !largeOk) {
      return setProblem("This is a very large file. Turn on “Save this large file anyway”, or make it smaller first.");
    }
    const temporaryUntil = keep === "temporary" ? temporaryExpiry(tempChoice, tempDate) : undefined;
    if (keep === "temporary" && !temporaryUntil) return setProblem("Choose the date this file should be deleted.");

    const where = whereWords();
    setSaving({ label: `Getting ready ${where}…`, value: 5 });
    try {
      const docs: NewDocumentInput[] = [];
      for (const [i, it] of items.entries()) {
        let content = it.bytes, mimeType = it.mimeType, extension = it.extension;
        if (single && optimised) {
          // already through the canvas, so already clean
          ({ bytes: content, mimeType, extension } = optimised);
        } else if (removeDetails && it.detection?.any && isProcessableImage(it.mimeType)) {
          try {
            ({ bytes: content, mimeType, extension } = await stripMetadata(it.bytes, it.mimeType));
          } catch {
            // Never save a photo with its location still in it while saying we removed it.
            setSaving(null);
            return setProblem(`We couldn't remove the hidden details from “${nameOf(it)}”. Turn off “Remove location and camera details” to save it as it is, or choose a different file.`);
          }
        }
        docs.push({
          content, mimeType, extension,
          meta: {
            name: nameOf(it).trim(), ownerProfileIds: owners, category, tags: [],
            document: expires ? { expiryDate: dateInputToIso(expires) } : undefined,
            temporary: temporaryUntil ? { expiresAt: temporaryUntil } : undefined,
          },
        });
        setSaving({ label: `Getting ready ${where}…`, value: 5 + Math.round(((i + 1) / items.length) * 25) });
      }

      setSaving({ label: `Encrypting ${where}…`, value: 30 });
      const { ids, synced } = await rpc.addDocuments(docs, (done, total) => {
        setSaving(done < total ? { label: `Encrypting ${where}…`, value: 30 + Math.round((done / total) * 50) } : { label: "Saving…" });
      });

      toast({
        message: synced
          ? (ids.length === 1 ? "Saved to your vault" : `Saved ${ids.length} documents to your vault`)
          : `Saved ${where}. It'll upload when you're back online.`,
      });
      router.replace(ids.length === 1 ? `/doc?id=${ids[0]}` : "/");
    } catch {
      setSaving(null);
      setProblem("That didn't save. Nothing was lost: check your connection and try again.");
    }
  };

  // ───────────────────────── render ─────────────────────────

  if (!index) return null;

  if (reading) {
    return (
      <Screen>
        <TopBar backLabel="Documents" backHref="/" />
        <ProgressBar label="Reading…" />
      </Screen>
    );
  }

  if (items.length === 0) {
    return (
      <Screen>
        {picker.input}
        <TopBar backLabel="Documents" backHref="/" />
        <ScreenHeader title="Add a document" size="title" />
        {emptyShare ? (
          <Banner tone="warn" title="The file didn't come through" secondaryAction={{ label: "Choose a file", onClick: picker.open }}>
            Your phone opened the vault but left the file behind. This is a fault in the current version of Chrome, not something you did. Choose the file here instead. If it&rsquo;s only open in another app, save it to your phone first.
          </Banner>
        ) : (
          <Banner tone="info" title="Nothing to add" secondaryAction={{ label: "Choose a file", onClick: picker.open }}>
            Choose a file to start. If you were in the middle of adding one, choose it again: files are never kept until you save them.
          </Banner>
        )}
      </Screen>
    );
  }

  const cat: CatTint = categoryInfo(category).cat;

  return (
    <Screen>
      {picker.input}
      <TopBar backLabel="Documents" backHref="/" />
      <ScreenHeader title={single ? "Add a document" : `Add ${items.length} documents`} size="title" />

      {single && (
        <PreviewCard cat={cat} imageUrl={thumb}
          tag={`${kindLabel((optimised ?? single).mimeType, (optimised ?? single).extension)} · ${formatBytes(sizeOf(single))}`} />
      )}

      {/* banners, only the ones that apply */}
      {blocked.length > 0 && (
        <Banner tone="warn" title={single ? "This file is too big for the vault" : `${plural(blocked.length, "file is", "files are")} too big for the vault`}
          secondaryAction={canShrink ? { label: "Make it smaller", onClick: () => void shrink() } : undefined}>
          Files up to {formatBytes(maxBytes)} fit.{" "}
          {single ? (canShrink ? "Make it smaller, then save it." : "Make it smaller first, then add it again.") : "Remove them from the list below to save the rest."}
        </Banner>
      )}

      {duplicates.length > 0 && !duplicatesOk && (single ? (
        <Banner tone="info" title="This exact file is already in your vault"
          action={{ label: "View existing", href: `/doc?id=${single.duplicate!.id}` }}
          secondaryAction={{ label: "Upload anyway", onClick: () => { setDuplicatesOk(true); setProblem(null); } }}>
          {single.duplicate!.name} · Added {formatDate(single.duplicate!.createdAt)}
        </Banner>
      ) : (
        <Banner tone="info" title={`${plural(duplicates.length, "of these is", "of these are")} already in your vault`}
          action={{ label: "Skip those", onClick: () => { setItems((l) => l.filter((it) => !it.duplicate)); setProblem(null); } }}
          secondaryAction={{ label: "Upload anyway", onClick: () => { setDuplicatesOk(true); setProblem(null); } }}>
          {duplicates.map((d) => d.duplicate!.name).join(" · ")}
        </Banner>
      ))}

      {single && !comparison && !optimised && (advice === "gentle" || advice === "strong" || advice === "confirm") && (
        <Banner tone="info" title={`This file is ${formatBytes(single.bytes.length)}`}
          secondaryAction={canShrink ? { label: optimising ? "Working…" : "Make it smaller", onClick: () => void shrink() } : undefined}>
          {advice === "gentle"
            ? "Most family documents fit comfortably under 1 MB. Making it smaller keeps the vault quick to open, especially without internet."
            : "That's large for a document. A smaller copy opens faster and takes less room on every phone in the family."}
          {!canShrink && single.mimeType === "application/pdf" && " It will be saved as it is."}
          {cannotProcess && " This kind of picture can't be made smaller here, so it will be saved as it is."}
        </Banner>
      )}

      {single && comparison && !optimised && (
        <Section>
          <GroupLabel as="h2">A smaller copy</GroupLabel>
          <Group>
            <KeyValueRow label="Original"
              value={`${formatBytes(single.bytes.length)} · ${kindLabel(single.mimeType, single.extension)}`}
              hint={`${comparison.original.width} × ${comparison.original.height}`} />
            <KeyValueRow label="Suggested"
              value={`${formatBytes(comparison.result.bytes.length)} · ${kindLabel(comparison.result.mimeType, comparison.result.extension)}`}
              hint={`${comparison.result.width} × ${comparison.result.height}`} />
            <KeyValueRow label="Estimated reduction"
              value={`${Math.max(0, Math.round((1 - comparison.result.bytes.length / single.bytes.length) * 100))}%`} />
            {category === "identity" && (
              <Row label="Keep maximum quality" description="Full size, for forms and portals that are fussy about scans"
                checked={maxQuality} onCheckedChange={(v) => { setMaxQuality(v); void shrink(v); }} />
            )}
          </Group>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Button variant="secondary" size="sm" loading={optimising} loadingLabel="Working…"
              onClick={() => { setOptimised(comparison.result); setProblem(null); }}>
              Use optimised
            </Button>
            <Button variant="text" size="sm" onClick={() => setComparison(null)}>Keep original</Button>
          </div>
        </Section>
      )}

      {single && optimised && (
        <Group>
          <KeyValueRow label="Using the smaller copy" value={formatBytes(optimised.bytes.length)}
            action={<Button variant="text" size="sm" onClick={() => { setOptimised(null); setComparison(null); }}>Undo</Button>} />
        </Group>
      )}

      {single && advice === "confirm" && (
        <Group>
          <Row label="Save this large file anyway" description="It will be slow to open on a phone" checked={largeOk}
            onCheckedChange={(v) => { setLargeOk(v); setProblem(null); }} />
        </Group>
      )}

      {withDetails.length > 0 && !(single && optimised) && (
        <Section>
          <GroupLabel as="h2">{single ? "This picture includes hidden details" : "Some of these pictures include hidden details"}</GroupLabel>
          <Group>
            <Row label="Remove location and camera details" description={detailWords.join(" · ")}
              checked={removeDetails} onCheckedChange={setRemoveDetails} />
          </Group>
        </Section>
      )}

      {/* what it is */}
      {single ? (
        <Field label="Name" helper="Shown in your list and in search." error={nameError ?? undefined}>
          <TextInput value={nameOf(single)} onChange={(e) => setName(single.key, e.target.value)} autoComplete="off" enterKeyHint="done" />
        </Field>
      ) : (
        <Section>
          <GroupLabel as="h2">Names</GroupLabel>
          <Group>
            {items.map((it) => {
              const tooBig = sizeAdvice(it.bytes.length, maxBytes) === "blocked";
              return (
                <Row key={it.key} leading={<Tile cat={cat} icon={FileText} />}
                  label={<TextInput value={nameOf(it)} aria-label={`Name for ${it.file.name}`} invalid={!nameOf(it).trim() && !!nameError}
                    onChange={(e) => setName(it.key, e.target.value)} autoComplete="off" className="min-h-11" />}
                  description={[
                    `${kindLabel(it.mimeType, it.extension)} · ${formatBytes(it.bytes.length)}`,
                    tooBig && "Too big to save", it.duplicate && !duplicatesOk && "Already in your vault",
                  ].filter(Boolean).join(" · ")}
                  trailing={<Button variant="text" size="sm" aria-label={`Remove ${nameOf(it) || it.file.name} from the list`}
                    onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))}>Remove</Button>} />
              );
            })}
          </Group>
        </Section>
      )}

      <CategoryPicker categories={categories} value={category} onChange={setCategory} />
      <PeoplePicker profiles={profiles} value={owners} onChange={setOwners} />

      <Field label="Expires" helper="Leave empty if it doesn't expire. We'll remind you before the date.">
        <TextInput type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </Field>

      <Section>
        <GroupLabel as="h2">Keep this file</GroupLabel>
        <SegmentedControl aria-label="Keep this file" fullWidth value={keep} onValueChange={setKeep}
          options={[{ value: "forever", label: "Until I delete it" }, { value: "temporary", label: "Temporarily" }]} />
        {keep === "temporary" && (
          <div className="mt-3 flex flex-col gap-3">
            <ChipRow aria-label="Delete after" overflow="wrap">
              {TEMPORARY_OPTIONS.map((o) => (
                <Chip key={o.id} selected={tempChoice === o.id} onClick={() => setTempChoice(o.id)}>{o.label}</Chip>
              ))}
              <Chip selected={tempChoice === "date"} onClick={() => setTempChoice("date")}>Choose date</Chip>
            </ChipRow>
            {tempChoice === "date" && (
              <Field label="Delete after">
                <TextInput type="date" value={tempDate} onChange={(e) => { setTempDate(e.target.value); setProblem(null); }} />
              </Field>
            )}
            <p className="px-1 text-callout text-ink-2">Good for boarding passes and tickets. It moves to the trash by itself when the time is up.</p>
          </div>
        )}
      </Section>

      {/* the one commit action; it turns into the progress bar while it works */}
      <div className="flex flex-col gap-3 pt-2">
        {problem && <p role="alert" className="px-1 text-callout text-danger">{problem}</p>}
        {saving ? (
          <ProgressBar label={saving.label} value={saving.value} className="min-h-13 justify-center" />
        ) : (
          <Button size="lg" onClick={() => void save()}>
            {single ? "Save to vault" : `Save ${items.length} documents`}
          </Button>
        )}
      </div>
    </Screen>
  );
}
