"use client";

import { Clock, Download, Ellipsis, FileQuestion, Share, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useVault } from "@/client/vault-provider";
import {
  Avatar, Banner, Button, type CatTint, Chip, ChipRow, EmptyState, Icon, type LucideIcon, MetaPill, ProgressBar, Screen,
  Sheet, StatusPill, TopBar, categoryInfo, useToast,
} from "@/components/ui";
import { TEMPORARY_OPTIONS, kindLabel } from "@/components/upload/dates";
import { activeProfiles } from "@/lib/documents";
import { formatBytes, formatCountdown, plural } from "@/lib/format";
import { isExpiredTemporary } from "@/vault/index-model";
import { downloadDocument, hasSeenShareWarning, markShareWarningSeen, shareDocument } from "./actions";
import { DetailsList } from "./details-list";
import { MoreSheet } from "./more-sheet";
import { PreviewCard } from "./preview-card";
import { useOpenedDocument } from "./use-opened-document";
import { usePreviewUrl } from "./use-preview-url";
import { Viewer } from "./viewer";

function TrioButton({ icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group/trio flex min-w-0 flex-col items-center gap-1.5 rounded-md py-1 text-[0.875rem] leading-5 font-medium text-ink">
      <span className="grid size-12 place-items-center rounded-full bg-sunken transition-colors duration-150 ease-out group-hover/trio:bg-sunken-pressed group-active/trio:bg-sunken-pressed group-active/trio:duration-0">
        <Icon icon={icon} />
      </span>
      {label}
    </button>
  );
}

/** re-renders once a minute, so "Deletes in 14h 32m" counts down */
function useMinuteTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [active]);
}

export function DocumentScreen({ id }: { id: string }) {
  const router = useRouter();
  const { state, rpc } = useVault();
  const { toast } = useToast();
  const index = state.index;
  const entry = index?.entries[id];

  const { open, opened, opening, problem, clearProblem } = useOpenedDocument(id);
  const [viewing, setViewing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [shareWarning, setShareWarning] = useState(false);
  const [extending, setExtending] = useState(false);
  const [pages, setPages] = useState<number | null>(null);
  const [working, setWorking] = useState<"share" | "download" | null>(null);

  useMinuteTick(!!entry?.temporary);

  // once a picture has been opened, the card shows the picture
  const isPicture = !!opened && /^image\/(jpeg|png|webp|avif|gif|bmp)$/.test(opened.header.mimeType);
  const thumb = usePreviewUrl(isPicture ? opened.content : null, opened?.header.mimeType);

  const goBack = useCallback(() => {
    if (window.history.length > 1) router.back();
    else router.replace("/");
  }, [router]);

  const name = entry?.name ?? "";

  const download = useCallback(async () => {
    setWorking("download");
    const doc = await open();
    setWorking(null);
    if (doc) downloadDocument(doc, name);
  }, [open, name]);

  const shareNow = useCallback(async () => {
    setWorking("share");
    const doc = await open();
    setWorking(null);
    if (!doc) return;
    const outcome = await shareDocument(doc, name);
    if (outcome === "needs-tap") toast({ message: "Ready. Tap Share once more." });
    if (outcome === "downloaded") toast({ message: "This device can't share files from here, so it was downloaded instead." });
  }, [open, name, toast]);

  const share = useCallback(() => {
    if (hasSeenShareWarning()) return void shareNow();
    setShareWarning(true);
    void open(); // decrypt while they read, so the tap on "Share" goes straight to the share sheet
  }, [shareNow, open]);

  if (!index) return null;

  if (!entry || entry.state === "trashed" || isExpiredTemporary(entry)) {
    const inTrash = !!entry;
    return (
      <Screen>
        <TopBar backLabel="Documents" onBack={goBack} />
        <EmptyState
          icon={inTrash ? Trash2 : FileQuestion}
          message={inTrash ? "This document is in the trash." : "This document isn't in your vault any more."}
          action={inTrash
            ? <Button size="sm" variant="secondary" href="/settings/trash">Open trash</Button>
            : <Button size="sm" variant="secondary" href="/">Back to documents</Button>}
        />
      </Screen>
    );
  }

  const category = index.categories.find((c) => c.id === entry.category && !c.deletedAt);
  const info = categoryInfo(entry.category, category?.name);
  const cat: CatTint = info.cat;
  const owners = activeProfiles(index).filter((p) => entry.ownerProfileIds.includes(p.id));
  const kind = kindLabel(entry.mimeType, entry.extension);
  const tag = pages ? `${kind} · ${plural(pages, "page")}` : `${kind} · ${formatBytes(entry.plaintextSize)}`;
  const onDevice = state.onDevice.includes(id);

  const retry = () => { clearProblem(); void open(); };

  return (
    <Screen gap="sm">
      <TopBar backLabel="Documents" onBack={goBack} action={<Button variant="text" href={`/doc/edit?id=${id}`}>Edit</Button>} />

      <PreviewCard cat={cat} tag={tag} imageUrl={thumb} label={`Open ${entry.name}`}
        onOpen={() => { setViewing(true); void open(); }} />

      <div>
        <h1 className="text-title break-words">{entry.name}</h1>
        {(entry.category || owners.length > 0) && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {entry.category && (
              <MetaPill leading={<span data-cat={cat} className="text-(--cat-fg)"><Icon icon={info.icon} className="size-[0.9375rem]" /></span>}>
                {category?.name ?? info.label}
              </MetaPill>
            )}
            {owners.map((p) => (
              <MetaPill key={p.id} leading={<Avatar name={p.displayName} emoji={p.avatar?.type === "emoji" ? p.avatar.value : undefined} cat={(p.tint as CatTint) ?? "other"} className="size-5 text-[0.6875rem]" />}>
                {p.displayName}
              </MetaPill>
            ))}
          </div>
        )}
      </div>

      {entry.temporary && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusPill tone="warn" icon={Clock}>Deletes in {formatCountdown(entry.temporary.expiresAt)}</StatusPill>
          <Button variant="text" size="sm" onClick={() => {
            const previous = entry.temporary;
            void rpc.updateMeta(id, { temporary: undefined });
            toast({ message: `${entry.name} will be kept until you delete it`, action: { label: "Undo", onAction: () => void rpc.updateMeta(id, { temporary: previous }) } });
          }}>Keep permanently</Button>
          <Button variant="text" size="sm" onClick={() => setExtending(true)}>Extend</Button>
        </div>
      )}

      {problem && !viewing && (
        problem === "integrity" ? (
          <Banner tone="danger" title="Integrity check failed." secondaryAction={{ label: "Try again", onClick: retry }}>
            This file may be damaged or incomplete.
          </Banner>
        ) : (
          <Banner tone="info" title={problem === "offline" ? "This one needs internet" : "That didn't open"} secondaryAction={{ label: "Try again", onClick: retry }}>
            {problem === "offline" ? "It isn't on this device yet. Connect to the internet and try again." : "Try again in a moment."}
          </Banner>
        )
      )}

      {working && !viewing ? (
        <ProgressBar label={working === "share" ? "Getting it ready to share…" : "Getting it ready to download…"} className="py-3" />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <TrioButton icon={Share} label="Share" onClick={share} />
          <TrioButton icon={Download} label="Download" onClick={() => void download()} />
          <TrioButton icon={Ellipsis} label="More" onClick={() => setMoreOpen(true)} />
        </div>
      )}

      <DetailsList index={index} entry={entry} onDevice={onDevice} />

      {viewing && (
        <Viewer name={entry.name} opened={opened} opening={opening} problem={problem} onRetry={retry}
          onClose={() => setViewing(false)} onShare={share} onDownload={() => void download()}
          onMore={() => setMoreOpen(true)} onPageCount={setPages} />
      )}

      <MoreSheet entry={entry} open={moreOpen} onOpenChange={setMoreOpen} />

      <Sheet open={shareWarning} onOpenChange={setShareWarning} title="Before you share">
        <p className="px-1 text-body text-ink-2">
          Once shared, this copy leaves Family Vault&rsquo;s protection. WhatsApp, email, and anything else you send it to will hold an ordinary, unprotected file.
        </p>
        <Button size="lg" icon={Share} onClick={() => { markShareWarningSeen(); setShareWarning(false); void shareNow(); }}>Share</Button>
      </Sheet>

      <Sheet open={extending} onOpenChange={setExtending} title="Keep it for longer" description="Choose how long from now." showDescription>
        <ChipRow aria-label="Delete after" overflow="wrap">
          {TEMPORARY_OPTIONS.map((o) => (
            <Chip key={o.id} selected={false} onClick={() => {
              setExtending(false);
              void rpc.updateMeta(id, { temporary: { expiresAt: new Date(Date.now() + o.ms).toISOString() } });
              toast({ message: `${entry.name} will be deleted in ${o.label}` });
            }}>{o.label}</Chip>
          ))}
        </ChipRow>
      </Sheet>
    </Screen>
  );
}
