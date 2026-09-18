"use client";

import { Folder, Lock, Plus } from "lucide-react";
import { useMemo } from "react";
import { useVault } from "@/client/vault-provider";
import { useShell } from "@/components/app-shell";
import {
  Button, CategoryGrid, CategoryTile, DEFAULT_CATEGORY_IDS, EmptyState, Group, GroupLabel, Screen, ScreenHeader,
  SearchField, Section, SkeletonRows,
} from "@/components/ui";
import { categoryHref, categoryOf } from "@/components/vault/category";
import { DocumentRow, ExpiryPill } from "@/components/vault/document-row";
import { HomeBanner } from "@/components/vault/home-banner";
import { forgetBrowseMemory } from "@/components/vault/memory";
import { PeopleChips } from "@/components/vault/people-chips";
import { useDocs } from "@/components/vault/use-docs";
import { categoryCounts, expiringSoon, recent } from "@/lib/documents";
import { daysFromToday, plural } from "@/lib/format";

const HOME_CATEGORIES = 4;
const NEW_FOR_DAYS = 7;

export default function DocumentsPage() {
  const { state, rpc, lock, online } = useVault();
  const { openAdd } = useShell();
  const { index, all, entries, profiles, activeProfileId } = useDocs();

  const expiring = useMemo(() => expiringSoon(entries), [entries]);
  const recents = useMemo(() => recent(entries, state.prefs.recent, 5), [entries, state.prefs.recent]);

  // the four most-used categories; a new vault shows the first four defaults rather than nothing
  const tiles = useMemo(() => {
    const counts = categoryCounts(entries);
    const used = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const ids = [...new Set([...used, ...DEFAULT_CATEGORY_IDS])].slice(0, HOME_CATEGORIES);
    return ids.map((id) => ({ id, count: counts.get(id) ?? 0 }));
  }, [entries]);

  const pending = state.sync?.pending ?? 0;
  const who = profiles.find((p) => p.id === activeProfileId);

  return (
    <Screen bottomBar>
      <ScreenHeader
        title="Documents"
        trailing={
          // from 1024 px the sidebar has Lock
          <Button
            variant="secondary"
            size="sm"
            icon={Lock}
            className="lg:hidden"
            onClick={() => {
              forgetBrowseMemory();
              void lock();
            }}
          >
            Lock
          </Button>
        }
      >
        {pending > 0 && (
          <span className="tabular text-ink-3">
            {online && !state.needsSession
              ? `Saving ${plural(pending, "change")}…`
              : `${plural(pending, "change")} will save when you're back online`}
          </span>
        )}
      </ScreenHeader>

      {/* sticks once it reaches the top; the canvas strip keeps rows from showing through around the pill */}
      <div className="sticky top-0 z-10 -my-2 bg-canvas py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <SearchField mode="button" href="/search" placeholder="Search documents, people…" />
      </div>

      <PeopleChips
        profiles={profiles}
        value={activeProfileId}
        onChange={(id) => void rpc.setPrefs({ activeProfileId: id })}
        className="-my-1"
      />

      <HomeBanner />

      {!index ? (
        <SkeletonRows count={4} />
      ) : all.length === 0 ? (
        <EmptyState
          icon={Folder}
          message="Nothing in your vault yet."
          action={<Button size="sm" icon={Plus} onClick={openAdd}>Add document</Button>}
        />
      ) : (
        <>
          {expiring.length > 0 && (
            <Section>
              <GroupLabel id="expiring">Expiring soon</GroupLabel>
              <Group>
                {expiring.map(({ entry, days }) => (
                  <DocumentRow key={entry.id} entry={entry} index={index} trailing={<ExpiryPill days={days} />} />
                ))}
              </Group>
            </Section>
          )}

          <Section>
            <GroupLabel action={<Button variant="text" size="sm" href="/categories">See all</Button>}>Categories</GroupLabel>
            <CategoryGrid>
              {tiles.map(({ id, count }) => {
                const info = categoryOf(index, id);
                return <CategoryTile key={id} cat={info.cat} icon={info.icon} name={info.label} count={count} href={categoryHref(id)} />;
              })}
            </CategoryGrid>
          </Section>

          <Section>
            <GroupLabel>Recent</GroupLabel>
            {recents.length > 0 ? (
              <Group>
                {recents.map((entry) => (
                  <DocumentRow
                    key={entry.id}
                    entry={entry}
                    index={index}
                    // "Added yesterday" while it's news; after that, whose it is says more
                    description={daysFromToday(entry.createdAt) >= -NEW_FOR_DAYS ? "added" : "category-person"}
                  />
                ))}
              </Group>
            ) : (
              <EmptyState
                icon={Folder}
                message={who ? `No documents for ${who.displayName} yet.` : "No documents yet."}
                action={<Button variant="secondary" size="sm" icon={Plus} onClick={openAdd}>Add document</Button>}
              />
            )}
          </Section>
        </>
      )}
    </Screen>
  );
}
