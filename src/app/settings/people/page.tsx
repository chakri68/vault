"use client";

import { Plus, Users } from "lucide-react";
import { useState } from "react";
import { useVault } from "@/client/vault-provider";
import {
  AVATAR_TINTS, Avatar, Button, type CatTint, Chip, ChipRow, ConfirmDialog, EmptyState, Field, Group, Row, Screen,
  ScreenHeader, Sheet, TextInput, TopBar, useToast,
} from "@/components/ui";
import { activeProfiles, visibleEntries } from "@/lib/documents";
import { plural } from "@/lib/format";
import type { VaultProfile } from "@/schemas/index";

interface Draft { id: string | null; name: string; tint: CatTint }

export default function PeoplePage() {
  const { state, rpc } = useVault();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<VaultProfile | null>(null);

  const index = state.index;
  const people = index ? activeProfiles(index) : [];
  const counts = new Map<string, number>();
  if (index) for (const e of visibleEntries(index)) for (const p of e.ownerProfileIds) counts.set(p, (counts.get(p) ?? 0) + 1);

  // each new person gets the next tint nobody is using yet; it's assigned once and stays
  const nextTint = (): CatTint => AVATAR_TINTS.find((t) => !people.some((p) => p.tint === t)) ?? AVATAR_TINTS[people.length % AVATAR_TINTS.length];

  const save = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) return setError("Type a name first, like Mom or Chakri.");
    await rpc.saveProfile({ id: draft.id ?? crypto.randomUUID(), displayName: name, tint: draft.tint });
    toast({ message: draft.id ? `Saved ${name}` : `Added ${name}` });
    setDraft(null);
  };

  return (
    <Screen gap="lg">
      <TopBar backLabel="Settings" backHref="/settings" />
      <ScreenHeader title="People" size="title">
        People are for organising documents. Everyone who can open the vault can see every document in it.
      </ScreenHeader>

      {people.length === 0 ? (
        <EmptyState icon={Users} message="Nobody added yet." action={<Button size="sm" icon={Plus} onClick={() => { setError(undefined); setDraft({ id: null, name: "", tint: nextTint() }); }}>Add a person</Button>} />
      ) : (
        <>
          <Group>
            {people.map((p) => (
              <Row
                key={p.id}
                leading={<Avatar name={p.displayName} emoji={p.avatar?.type === "emoji" ? p.avatar.value : undefined} cat={(p.tint as CatTint) ?? "other"} size={40} />}
                label={p.displayName}
                description={plural(counts.get(p.id) ?? 0, "document")}
                onClick={() => { setError(undefined); setDraft({ id: p.id, name: p.displayName, tint: (p.tint as CatTint) ?? "other" }); }}
                chevron
              />
            ))}
          </Group>
          <Button variant="secondary" size="lg" icon={Plus} onClick={() => { setError(undefined); setDraft({ id: null, name: "", tint: nextTint() }); }}>Add a person</Button>
        </>
      )}

      <Sheet open={!!draft} onOpenChange={(o) => !o && setDraft(null)} title={draft?.id ? "Edit person" : "Add a person"}>
        {draft && (
          <>
            <Field label="Name" error={error}>
              <TextInput value={draft.name} autoFocus onChange={(e) => { setError(undefined); setDraft({ ...draft, name: e.target.value }); }} autoComplete="off" />
            </Field>
            <div>
              <p className="pb-2 text-callout font-semibold text-ink-2">Colour</p>
              <ChipRow aria-label="Colour" overflow="wrap">
                {AVATAR_TINTS.map((t) => (
                  <Chip key={t} selected={draft.tint === t} onClick={() => setDraft({ ...draft, tint: t })} avatar={<Avatar name={draft.name || "A"} cat={t} />}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </Chip>
                ))}
              </ChipRow>
            </div>
            <Button size="lg" onClick={() => void save()}>{draft.id ? "Save person" : "Add person"}</Button>
            {draft.id && (
              <Group>
                <Row danger label={`Remove ${draft.name || "this person"}`} onClick={() => { setRemoving(people.find((p) => p.id === draft.id) ?? null); setDraft(null); }} />
              </Group>
            )}
          </>
        )}
      </Sheet>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.displayName} from the vault?`}
        body="Their documents stay in the vault. They just won't be filed under this name any more. This can't be undone."
        confirmLabel="Remove person"
        onConfirm={() => {
          if (!removing) return;
          const name = removing.displayName;
          void rpc.removeProfile(removing.id).then(() => toast({ message: `Removed ${name}` }));
          if (state.prefs.activeProfileId === removing.id) void rpc.setPrefs({ activeProfileId: null });
          setRemoving(null);
        }}
      />
    </Screen>
  );
}
