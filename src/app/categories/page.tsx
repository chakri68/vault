"use client";

import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useVault } from "@/client/vault-provider";
import {
  Button, CategoryGrid, CategoryTile, DEFAULT_CATEGORY_IDS, Field, Group, Row, Screen, ScreenHeader, Sheet, SkeletonRows,
  TextInput, TopBar, useToast,
} from "@/components/ui";
import { categoryHref, categoryOf } from "@/components/vault/category";
import { PeopleChips } from "@/components/vault/people-chips";
import { useDocs } from "@/components/vault/use-docs";
import { activeCategories, categoryCounts } from "@/lib/documents";

const ORDER = new Map<string, number>(DEFAULT_CATEGORY_IDS.map((id, i) => [id, i]));

export default function CategoriesPage() {
  const { rpc } = useVault();
  const { toast } = useToast();
  const { index, entries, profiles, activeProfileId } = useDocs();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // the built-in categories in their usual order, then the family's own, alphabetically
  const categories = useMemo(() => {
    if (!index) return [];
    return [...activeCategories(index)].sort((a, b) => {
      const ai = ORDER.get(a.id), bi = ORDER.get(b.id);
      if (ai !== undefined || bi !== undefined) return (ai ?? 99) - (bi ?? 99);
      return a.name.localeCompare(b.name);
    });
  }, [index]);
  const counts = useMemo(() => categoryCounts(entries), [entries]);

  const close = (open: boolean) => {
    setAdding(open);
    if (!open) {
      setName("");
      setError(null);
    }
  };

  const save = async () => {
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) return setError("Give the category a name, like “Vehicles”.");
    if (clean.length > 40) return setError("Keep the name under 40 characters.");
    const taken = categories.find((c) => c.name.toLowerCase() === clean.toLowerCase());
    if (taken) return setError(`You already have a category called ${taken.name}.`);
    setSaving(true);
    try {
      // the id is opaque and lives inside the encrypted index; the name is what people see
      await rpc.saveCategory(`cat-${crypto.randomUUID().slice(0, 8)}`, clean);
      close(false);
      toast({ message: `Added ${clean}` });
    } catch {
      setError("That didn't save. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <div>
        <TopBar backLabel="Documents" backHref="/" />
        <ScreenHeader title="Categories" size="title" />
      </div>

      <PeopleChips profiles={profiles} value={activeProfileId} onChange={(id) => void rpc.setPrefs({ activeProfileId: id })} className="-my-1" />

      {!index ? (
        <SkeletonRows count={4} tile={false} />
      ) : (
        <>
          <CategoryGrid>
            {categories.map((c) => {
              const info = categoryOf(index, c.id);
              return (
                <CategoryTile key={c.id} cat={info.cat} icon={info.icon} name={info.label} count={counts.get(c.id) ?? 0} href={categoryHref(c.id, "categories")} />
              );
            })}
          </CategoryGrid>
          <Group>
            <Row icon={Plus} label="Add category" description="For anything the list above doesn't cover" chevron={false} onClick={() => setAdding(true)} />
          </Group>
        </>
      )}

      <Sheet open={adding} onOpenChange={close} title="New category">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Name" error={error ?? undefined} helper="Shown on Documents and when you add a file.">
            <TextInput
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              autoFocus
              autoComplete="off"
              enterKeyHint="done"
              maxLength={60}
            />
          </Field>
          <Button type="submit" size="lg" loading={saving} loadingLabel="Adding…">Add category</Button>
        </form>
      </Sheet>
    </Screen>
  );
}
