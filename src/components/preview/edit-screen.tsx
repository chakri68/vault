"use client";

import { FileQuestion, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useId, useMemo, useState } from "react";
import { useVault } from "@/client/vault-provider";
import {
  Button, Chip, ChipRow, EmptyState, Field, Group, GroupLabel, Icon, MonoInput, Row, Screen, ScreenHeader, Section,
  SegmentedControl, TextInput, TopBar, cn, useToast,
} from "@/components/ui";
import {
  TEMPORARY_OPTIONS, type TemporaryChoice, dateInputToIso, isoToDateInput, temporaryExpiry,
} from "@/components/upload/dates";
import { CategoryPicker, PeoplePicker } from "@/components/upload/meta-pickers";
import { activeCategories, activeProfiles } from "@/lib/documents";
import { formatCountdown } from "@/lib/format";
import type { IndexEntry } from "@/schemas/index";
import type { MetaPatch } from "@/vault/index-model";

const DEFAULT_REMINDERS = [6, 3, 1];
const REMINDER_ROWS = [
  { months: 6, label: "6 months before" },
  { months: 3, label: "3 months before" },
  { months: 1, label: "1 month before" },
];

const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

export function EditScreen({ id }: { id: string }) {
  const router = useRouter();
  const { state } = useVault();
  const entry = state.index?.entries[id];

  const goBack = useCallback(() => {
    if (window.history.length > 1) router.back();
    else router.replace(`/doc?id=${id}`);
  }, [router, id]);

  if (!state.index) return null;
  if (!entry || entry.state !== "active") {
    return (
      <Screen>
        <TopBar backLabel="Documents" backHref="/" />
        <EmptyState icon={FileQuestion} message="This document isn't in your vault any more."
          action={<Button size="sm" variant="secondary" href="/">Back to documents</Button>} />
      </Screen>
    );
  }
  // keyed on the id: the form's starting values are read once, from the entry as it was when the screen opened
  return <EditForm key={entry.id} entry={entry} onDone={goBack} />;
}

function EditForm({ entry, onDone }: { entry: IndexEntry; onDone: () => void }) {
  const { state, rpc } = useVault();
  const { toast } = useToast();
  const index = state.index!;
  const noteId = useId();

  const [name, setName] = useState(entry.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [category, setCategory] = useState(entry.category);
  const [owners, setOwners] = useState(entry.ownerProfileIds);
  const [number, setNumber] = useState(entry.document?.referenceNumber ?? "");
  const [expires, setExpires] = useState(isoToDateInput(entry.document?.expiryDate));
  const [issued, setIssued] = useState(isoToDateInput(entry.document?.issueDate));
  const [issuer, setIssuer] = useState(entry.document?.issuer ?? "");
  const [reminders, setReminders] = useState(entry.reminders ?? DEFAULT_REMINDERS);
  const [tags, setTags] = useState(entry.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [note, setNote] = useState(entry.note ?? "");
  const [keep, setKeep] = useState<"forever" | "temporary">(entry.temporary ? "temporary" : "forever");
  const [tempChoice, setTempChoice] = useState<TemporaryChoice | "unchanged">(entry.temporary ? "unchanged" : "24h");
  const [tempDate, setTempDate] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const categories = useMemo(() => activeCategories(index), [index]);
  const profiles = useMemo(() => activeProfiles(index), [index]);

  const addTags = (raw: string) => {
    const next = raw.split(",").map((t) => t.trim()).filter(Boolean);
    if (next.length) setTags((list) => [...list, ...next.filter((t) => !list.some((x) => x.toLowerCase() === t.toLowerCase()))].slice(0, 64));
    setTagDraft("");
  };

  const save = async () => {
    setProblem(null);
    const cleanName = name.trim();
    if (!cleanName) return setNameError("Give it a name, so you can find it later.");
    const allTags = tagDraft.trim() ? [...tags, ...tagDraft.split(",").map((t) => t.trim()).filter((t) => t && !tags.includes(t))] : tags;

    // only what changed goes in the patch, so an edit made elsewhere to another field isn't overwritten by a stale form
    const patch: MetaPatch = {};
    if (cleanName !== entry.name) patch.name = cleanName;
    if (category !== entry.category) patch.category = category;
    if (!sameList(owners, entry.ownerProfileIds)) patch.ownerProfileIds = owners;
    if (number.trim() !== (entry.document?.referenceNumber ?? "")) patch.referenceNumber = number.trim() || undefined;
    if (expires !== isoToDateInput(entry.document?.expiryDate)) patch.expiryDate = dateInputToIso(expires);
    if (issued !== isoToDateInput(entry.document?.issueDate)) patch.issueDate = dateInputToIso(issued);
    if (issuer.trim() !== (entry.document?.issuer ?? "")) patch.issuer = issuer.trim() || undefined;
    if (!sameList(allTags, entry.tags)) patch.tags = allTags;
    if (note.trim() !== (entry.note ?? "")) patch.note = note.trim() || undefined;
    if (expires && !sameList(reminders, entry.reminders ?? DEFAULT_REMINDERS)) patch.reminders = reminders;

    if (keep === "forever" && entry.temporary) patch.temporary = undefined;
    if (keep === "temporary" && tempChoice !== "unchanged") {
      const expiresAt = temporaryExpiry(tempChoice, tempDate);
      if (!expiresAt) return setProblem("Choose the date this file should be deleted.");
      patch.temporary = { expiresAt };
    }

    if (Object.keys(patch).length > 0) {
      setSaving(true);
      try {
        await rpc.updateMeta(entry.id, patch);
      } catch {
        setSaving(false);
        return setProblem("That didn't save. Try again.");
      }
      toast({ message: "Saved" });
    }
    onDone();
  };

  return (
    <Screen>
      <TopBar backLabel={entry.name} onBack={onDone} />
      <ScreenHeader title="Edit details" size="title" />

      <Field label="Name" error={nameError ?? undefined}>
        <TextInput value={name} onChange={(e) => { setName(e.target.value); setNameError(null); }} autoComplete="off" />
      </Field>

      <CategoryPicker categories={categories} value={category} onChange={setCategory} />
      <PeoplePicker profiles={profiles} value={owners} onChange={setOwners} />

      <Field label="Document number" helper="Passport, PAN, policy or account number. It stays hidden on the document until you tap Show.">
        <MonoInput value={number} onValueChange={setNumber} maxLength={64} inputMode="text" />
      </Field>

      <Field label="Expires" helper="Leave empty if it doesn't expire.">
        <TextInput type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </Field>

      {expires && (
        <Section>
          <GroupLabel as="h2">Remind us</GroupLabel>
          <Group>
            {REMINDER_ROWS.map((r) => (
              <Row key={r.months} label={r.label} checked={reminders.includes(r.months)}
                onCheckedChange={(on) => setReminders((list) => (on ? [...list, r.months] : list.filter((m) => m !== r.months)))} />
            ))}
          </Group>
        </Section>
      )}

      <Field label="Issued">
        <TextInput type="date" value={issued} onChange={(e) => setIssued(e.target.value)} />
      </Field>

      <Field label="Issued by">
        <TextInput value={issuer} onChange={(e) => setIssuer(e.target.value)} autoComplete="off" />
      </Field>

      <Field label="Tags" helper="Separate with a comma. Tags are searchable.">
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {tags.map((t) => (
              <button key={t} type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags((list) => list.filter((x) => x !== t))}
                className="relative inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full bg-sunken pr-2.5 pl-3.5 text-callout font-medium text-ink transition-colors duration-150 after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] hover:bg-sunken-pressed active:bg-sunken-pressed active:duration-0">
                <span className="truncate">{t}</span>
                <Icon icon={X} className="size-4 text-ink-2" />
              </button>
            ))}
          </div>
        )}
        <TextInput value={tagDraft} autoComplete="off" autoCapitalize="none" enterKeyHint="done"
          onChange={(e) => (e.target.value.includes(",") ? addTags(e.target.value) : setTagDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); addTags(tagDraft); }
            if (e.key === "Backspace" && !tagDraft && tags.length) setTags((list) => list.slice(0, -1));
          }}
          onBlur={() => addTags(tagDraft)} />
      </Field>

      <div className="flex min-w-0 flex-col gap-2">
        <label htmlFor={noteId} className="text-callout font-semibold text-ink-2">Note</label>
        <textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={4000}
          className={cn(
            "min-h-28 w-full resize-y rounded-md border border-control bg-surface px-3.5 py-3 text-body text-ink outline-none",
            "transition-[border-color,box-shadow] duration-150 focus:border-accent focus:shadow-[0_0_0_4px_var(--accent-soft)]",
          )} />
        <p className="text-callout text-ink-3">Anyone in the family who can open the vault can read this.</p>
      </div>

      <Section>
        <GroupLabel as="h2">Keep this file</GroupLabel>
        <SegmentedControl aria-label="Keep this file" fullWidth value={keep} onValueChange={setKeep}
          options={[{ value: "forever", label: "Until I delete it" }, { value: "temporary", label: "Temporarily" }]} />
        {keep === "temporary" && (
          <div className="mt-3 flex flex-col gap-3">
            <ChipRow aria-label="Delete after" overflow="wrap">
              {entry.temporary && (
                <Chip selected={tempChoice === "unchanged"} onClick={() => setTempChoice("unchanged")}>
                  As it is ({formatCountdown(entry.temporary.expiresAt)} left)
                </Chip>
              )}
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
          </div>
        )}
      </Section>

      <div className="flex flex-col gap-3 pt-2">
        {problem && <p role="alert" className="px-1 text-callout text-danger">{problem}</p>}
        <Button size="lg" loading={saving} loadingLabel="Saving…" onClick={() => void save()}>Save changes</Button>
      </div>
    </Screen>
  );
}
