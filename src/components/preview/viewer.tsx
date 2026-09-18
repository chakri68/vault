"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Download, Ellipsis, Share, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type LucideIcon, ProgressBar, cn } from "@/components/ui";
import { PdfPages } from "./pdf-pages";
import type { OpenProblem, OpenedDocument } from "./use-opened-document";
import { usePreviewUrl } from "./use-preview-url";
import { ZoomableImage, type ZoomHandle } from "./zoomable-image";

/**
 * The viewer is dark in both themes: documents are photographed on white, and
 * a dark surround frames them. Rather than a second set of components, the dark
 * token values are pinned on this subtree, so `text-ink` and friends resolve to
 * the dark palette here whatever the OS says. (Values are ui_theme.md's dark column.)
 */
const DARK_SCOPE = "theme-dark";

const MAX_TEXT = 1_000_000;

type Kind = "image" | "pdf" | "text" | "other";

function kindOf(mimeType: string): Kind {
  if (mimeType === "application/pdf") return "pdf";
  if (/^image\/(jpeg|png|webp|avif|gif|bmp)$/.test(mimeType)) return "image";
  if (mimeType.startsWith("text/")) return "text";
  return "other";
}

function BarButton({ icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex min-h-13 min-w-16 flex-1 flex-col items-center justify-center gap-1 rounded-md text-[0.875rem] leading-5 font-medium text-ink transition-colors duration-150 hover:bg-pressed active:bg-pressed active:duration-0">
      <Icon icon={icon} className="size-5.5" />
      {label}
    </button>
  );
}

export function Viewer({ name, opened, opening, problem, onRetry, onClose, onShare, onDownload, onMore, onPageCount }: {
  name: string;
  opened: OpenedDocument | null;
  opening: boolean;
  problem: OpenProblem | null;
  onRetry: () => void;
  onClose: () => void;
  onShare: () => void;
  onDownload: () => void;
  onMore: () => void;
  onPageCount?: (pages: number) => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const [failed, setFailed] = useState(false);
  const zoom = useRef<ZoomHandle>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const kind: Kind = failed ? "other" : opened ? kindOf(opened.header.mimeType) : "other";

  // Its own history entry, so Android's back button closes the viewer instead of leaving the document.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    if (!(window.history.state as { fvViewer?: boolean } | null)?.fvViewer) {
      window.history.pushState({ fvViewer: true }, "");
    }
    const back = () => onCloseRef.current();
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  const close = useCallback(() => {
    if ((window.history.state as { fvViewer?: boolean } | null)?.fvViewer) window.history.back();
    else onCloseRef.current();
  }, []);

  // every preview URL goes through the registry, so locking revokes it even if this never unmounts cleanly
  const isImage = !!opened && kindOf(opened.header.mimeType) === "image";
  const imageUrl = usePreviewUrl(isImage ? opened.content : null, opened?.header.mimeType);

  const text = useMemo(() => {
    if (!opened || kindOf(opened.header.mimeType) !== "text") return null;
    const body = new TextDecoder("utf-8").decode(opened.content.subarray(0, MAX_TEXT));
    return opened.content.length > MAX_TEXT ? `${body}\n\n… Download the file to read the rest.` : body;
  }, [opened]);

  const canZoom = !!opened && (kind === "image" || kind === "pdf");

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) close(); }}>
      <Dialog.Portal>
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => { e.preventDefault(); closeButton.current?.focus(); }}
          className={cn(DARK_SCOPE, "fixed inset-0 z-50 flex flex-col bg-viewer text-ink outline-none data-[state=open]:anim-fade-in")}
        >
          {/* top: close is always visible, always labelled */}
          <div className="flex min-h-13 flex-none items-center justify-between gap-3 px-2 pt-[env(safe-area-inset-top)]">
            <button ref={closeButton} type="button" onClick={close}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full pr-3.5 pl-2.5 text-label text-ink transition-colors duration-150 hover:bg-pressed active:bg-pressed active:duration-0">
              <Icon icon={X} className="size-5.5" />
              Close
            </button>
            <Dialog.Title className="min-w-0 flex-1 truncate text-center text-callout text-ink-2">{name}</Dialog.Title>
            {canZoom ? (
              <button type="button" aria-pressed={zoomed}
                onClick={() => (kind === "image" ? zoom.current?.toggle() : setZoomed((z) => !z))}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-callout font-semibold text-ink transition-colors duration-150 hover:bg-pressed active:bg-pressed active:duration-0">
                <Icon icon={zoomed ? ZoomOut : ZoomIn} />
                {zoomed ? "Zoom out" : "Zoom in"}
              </button>
            ) : <span className="w-20 shrink-0" />}
          </div>

          <div className="relative min-h-0 flex-1">
            {problem ? (
              <Message title={problem === "integrity" ? "Integrity check failed." : problem === "offline" ? "This one needs internet." : "That didn't open."}
                body={problem === "integrity" ? "This file may be damaged or incomplete."
                  : problem === "offline" ? "It isn't on this device yet. Connect to the internet and try again."
                  : "Try again in a moment."}
                action={{ label: "Try again", onClick: onRetry }} />
            ) : !opened || opening ? (
              <div className="mx-auto mt-[30dvh] w-64 max-w-[80%]"><ProgressBar label="Opening…" /></div>
            ) : kind === "image" && imageUrl ? (
              <ZoomableImage src={imageUrl} alt={name} handle={zoom} onZoomChange={setZoomed} onSwipeDown={close} />
            ) : kind === "pdf" ? (
              <PdfPages content={opened.content} zoomed={zoomed} onPageCount={onPageCount} onFailed={() => setFailed(true)} />
            ) : kind === "text" ? (
              <pre tabIndex={0} className="size-full overflow-auto px-4 py-3 font-mono text-callout whitespace-pre-wrap break-words text-ink select-text">{text}</pre>
            ) : (
              <Message title="This file can't be shown here" body="Download it to open it in another app." action={{ label: "Download", onClick: onDownload }} />
            )}
          </div>

          {/* bottom: the same three labelled actions as the document screen */}
          <div className="flex-none border-t border-line bg-viewer/85 px-3 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-md">
            <div className="mx-auto flex max-w-md items-stretch gap-1">
              <BarButton icon={Share} label="Share" onClick={onShare} />
              <BarButton icon={Download} label="Download" onClick={onDownload} />
              <BarButton icon={Ellipsis} label="More" onClick={onMore} />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Message({ title, body, action }: { title: string; body: string; action: { label: string; onClick: () => void } }) {
  return (
    <div className="mx-auto flex h-full max-w-sm flex-col items-center justify-center gap-2 px-6 text-center">
      <h2 className="text-heading">{title}</h2>
      <p className="text-callout text-ink-2">{body}</p>
      <button type="button" onClick={action.onClick}
        className="mt-3 inline-flex min-h-12 items-center rounded-full bg-sunken px-5 text-label font-semibold text-ink transition-colors duration-150 hover:bg-sunken-pressed active:bg-sunken-pressed active:duration-0">
        {action.label}
      </button>
    </div>
  );
}
