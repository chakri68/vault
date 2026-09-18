"use client";

import { History } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useVault } from "@/client/vault-provider";
import { Availability, Button, Chip, ChipRow, Group, GroupLabel, Row, Screen, SearchField, Section, SkeletonRows } from "@/components/ui";
import { categoryOf, documentHref } from "@/components/vault/category";
import { DocumentRow } from "@/components/vault/document-row";
import { getRecentSearches, rememberSearch } from "@/components/vault/memory";
import { PeopleChips } from "@/components/vault/people-chips";
import { useDocs } from "@/components/vault/use-docs";
import { type SearchHit, categoryCounts, ownersLabel, search } from "@/lib/documents";
import type { VaultIndex } from "@/schemas/index";

const WHERE: Record<string, string> = { tag: "tags", note: "notes", issuer: "issuer", number: "number" };

/** "Identity · Mom · Also in notes": the second line says why a result is here when the name alone doesn't. */
function context(hit: SearchHit, index: VaultIndex): string {
  const owners = ownersLabel(index, hit.entry);
  const parts = [categoryOf(index, hit.entry.category).label, owners].filter(Boolean);
  const elsewhere = hit.matchedIn.map((k) => WHERE[k]).filter(Boolean);
  if (elsewhere.length > 0) {
    const list = elsewhere.length > 1 ? `${elsewhere.slice(0, -1).join(", ")} and ${elsewhere.at(-1)}` : elsewhere[0];
    parts.push(`${hit.nameRanges.length > 0 ? "Also in" : "Found in"} ${list}`);
  }
  return parts.join(" · ");
}

export default function SearchPage() {
  const router = useRouter();
  const { state } = useVault();
  const { index, all, profiles } = useDocs();
  const [query, setQuery] = useState("");
  // Search covers the whole vault to begin with, whoever is picked on Documents.
  const [profileId, setProfileId] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [recents, setRecents] = useState(getRecentSearches);

  const onDevice = useMemo(() => new Set(state.onDevice), [state.onDevice]);
  const categories = useMemo(() => [...categoryCounts(all).keys()], [all]);
  const hits = useMemo(
    () => (index ? search(index, query, { profileId, category }) : []),
    [index, query, profileId, category],
  );

  const typed = query.trim().length > 0;
  const remember = () => {
    rememberSearch(query);
    setRecents(getRecentSearches());
  };

  return (
    <Screen gap="sm">
      <h1 className="sr-only">Search</h1>
      <div className="sticky top-0 z-10 -mb-2 flex items-center gap-1 bg-canvas pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <SearchField
          value={query}
          onValueChange={setQuery}
          onSubmit={remember}
          autoFocus
          placeholder="Search documents, people, numbers"
          className="min-w-0 flex-1"
        />
        <Button variant="text" onClick={() => (window.history.length > 1 ? router.back() : router.push("/"))}>Cancel</Button>
      </div>

      <PeopleChips profiles={profiles} value={profileId} onChange={setProfileId} aria-label="Whose documents" className="-my-1" />
      {index && categories.length > 1 && (
        <ChipRow aria-label="Category" className="-my-1">
          <Chip selected={category === null} onClick={() => setCategory(null)}>All categories</Chip>
          {categories.map((id) => (
            <Chip key={id} selected={category === id} onClick={() => setCategory(category === id ? null : id)}>
              {categoryOf(index, id).label}
            </Chip>
          ))}
        </ChipRow>
      )}

      {!index ? (
        <SkeletonRows count={3} />
      ) : !typed ? (
        recents.length > 0 ? (
          <Section className="mt-2">
            <GroupLabel>Recent searches</GroupLabel>
            <Group>
              {recents.map((q) => (
                <Row key={q} icon={History} label={q} chevron={false} onClick={() => setQuery(q)} />
              ))}
            </Group>
          </Section>
        ) : (
          <p className="mt-2 px-1 text-callout text-ink-3">Search looks at names, people, tags, notes and numbers.</p>
        )
      ) : hits.length === 0 ? (
        <div className="mt-2 flex flex-col gap-1 px-1" role="status">
          <p className="text-body break-words">Nothing matches “{query.trim()}”.</p>
          <p className="text-callout text-ink-3">Search looks at names, people, tags, notes and numbers.</p>
        </div>
      ) : (
        <Section className="mt-2">
          <GroupLabel>
            <span role="status">{hits.length === 1 ? "1 document" : `${hits.length} documents`}</span>
          </GroupLabel>
          <Group>
            {hits.map((hit) => (
              <DocumentRow
                key={hit.entry.id}
                entry={hit.entry}
                index={index}
                nameRanges={hit.nameRanges}
                chevron
                href={documentHref(hit.entry)}
                onClick={remember}
                description={
                  <>
                    <span className="block truncate">{context(hit, index)}</span>
                    <Availability onDevice={onDevice.has(hit.entry.id)} className="mt-0.5" />
                  </>
                }
              />
            ))}
          </Group>
        </Section>
      )}
    </Screen>
  );
}
