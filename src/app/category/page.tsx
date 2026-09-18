"use client";

import { Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useVault } from "@/client/vault-provider";
import { useShell } from "@/components/app-shell";
import { Button, CATEGORIES, EmptyState, Group, Screen, ScreenHeader, SegmentedControl, SkeletonRows, TopBar } from "@/components/ui";
import { categoryOf, emptyCategoryMessage } from "@/components/vault/category";
import { DocumentRow, ExpiryPill } from "@/components/vault/document-row";
import { PeopleChips } from "@/components/vault/people-chips";
import { useDocs } from "@/components/vault/use-docs";
import { expiringSoon, ownersLabel } from "@/lib/documents";
import { formatRelative } from "@/lib/format";
import type { IndexEntry } from "@/schemas/index";

type Sort = "recent" | "name" | "expiry";
const SORTS = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "expiry", label: "Expiry" },
] as const;

function sorted(entries: IndexEntry[], sort: Sort): IndexEntry[] {
  const list = [...entries];
  if (sort === "name") return list.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "expiry") {
    // soonest first; documents that never expire go last, newest first among themselves
    return list.sort((a, b) => {
      const ae = a.document?.expiryDate, be = b.document?.expiryDate;
      if (ae && be) return ae < be ? -1 : ae > be ? 1 : 0;
      if (ae || be) return ae ? -1 : 1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function CategoryList() {
  const params = useSearchParams();
  const id = params.get("c") ?? "other";
  const fromCategories = params.get("from") === "categories";
  const { rpc } = useVault();
  const { openAdd } = useShell();
  const { index, entries, profiles, activeProfileId } = useDocs();
  const [sort, setSort] = useState<Sort>("recent");

  const inCategory = useMemo(() => entries.filter((e) => (e.category ?? "other") === id), [entries, id]);
  const list = useMemo(() => sorted(inCategory, sort), [inCategory, sort]);
  const soon = useMemo(() => new Map(expiringSoon(inCategory).map((x) => [x.entry.id, x.days])), [inCategory]);

  const info = index ? categoryOf(index, id) : null;
  const who = profiles.find((p) => p.id === activeProfileId);

  return (
    <Screen>
      <div>
        <TopBar backLabel={fromCategories ? "Categories" : "Documents"} backHref={fromCategories ? "/categories" : "/"} />
        <ScreenHeader title={info?.label ?? "Documents"} size="title" />
      </div>

      <PeopleChips profiles={profiles} value={activeProfileId} onChange={(pid) => void rpc.setPrefs({ activeProfileId: pid })} className="-my-1" />

      {!index || !info ? (
        <SkeletonRows count={4} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={info.icon}
          cat={info.cat}
          message={who ? `${emptyCategoryMessage(info, id in CATEGORIES).replace(/\.$/, "")} for ${who.displayName}.` : emptyCategoryMessage(info, id in CATEGORIES)}
          action={<Button size="sm" icon={Plus} onClick={openAdd}>Add document</Button>}
        />
      ) : (
        <>
          {list.length > 1 && (
            <SegmentedControl aria-label="Sort by" value={sort} onValueChange={setSort} options={SORTS} className="self-start" />
          )}
          <Group>
            {list.map((entry) => {
              const owners = ownersLabel(index, entry);
              const days = soon.get(entry.id);
              return (
                <DocumentRow
                  key={entry.id}
                  entry={entry}
                  index={index}
                  // the category is the screen's title, so the second line is free for who and when
                  description={sort === "expiry" ? "expiry" : [owners, `Added ${formatRelative(entry.createdAt)}`].filter(Boolean).join(" · ")}
                  trailing={days !== undefined ? <ExpiryPill days={days} /> : undefined}
                  chevron={days === undefined}
                />
              );
            })}
          </Group>
        </>
      )}
    </Screen>
  );
}

export default function CategoryPage() {
  // useSearchParams needs a boundary for the page to stay statically prerenderable (and so available offline)
  return (
    <Suspense fallback={<Screen><span /></Screen>}>
      <CategoryList />
    </Suspense>
  );
}
