"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { Button, IconButton } from "./button";
import { cn } from "./cn";

const scrim = "fixed inset-0 z-50 bg-scrim data-[state=open]:anim-fade-in data-[state=closed]:anim-fade-out";

/* ---------- Sheet ---------- */

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 17/600 in the title row. Usually the thing the sheet acts on: "Passport — Mom". */
  title: string;
  /** Read out with the title; visually hidden unless `showDescription`. */
  description?: string;
  showDescription?: boolean;
  /** List groups, mostly. Destructive rows go in their own group at the bottom. */
  children: ReactNode;
  className?: string;
}

/**
 * Bottom sheet under 640 px, centred dialog (max 440 px) above it. Radix Dialog
 * underneath for the focus trap, Escape and scroll lock.
 */
export function Sheet({ open, onOpenChange, title, description, showDescription = false, children, className }: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={scrim} />
        <Dialog.Content
          // Radix wires the description id itself; say so explicitly when there isn't one
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed z-50 flex max-h-[90dvh] flex-col gap-4 overflow-y-auto bg-canvas shadow-float outline-none",
            // phone: pinned to the bottom edge, top corners rounded
            "inset-x-0 bottom-0 rounded-t-xl px-4 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]",
            "data-[state=open]:anim-sheet-in data-[state=closed]:anim-sheet-out",
            // ≥ 640: centred dialog
            "sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[calc(100%-3rem)] sm:max-w-[27.5rem]",
            "sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:p-5 sm:pt-4",
            "sm:data-[state=open]:anim-dialog-in sm:data-[state=closed]:anim-dialog-out",
            className,
          )}
        >
          <span aria-hidden className="mx-auto h-[0.3125rem] w-9 shrink-0 rounded-full bg-control opacity-55 sm:hidden" />
          <div className="flex items-center justify-between gap-3 pl-1">
            <Dialog.Title className="min-w-0 text-label font-semibold break-words">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton icon={X} aria-label="Close" className="-mr-1.5" />
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description className={showDescription ? "-mt-2 px-1 text-callout text-ink-2" : "sr-only"}>
              {description}
            </Dialog.Description>
          ) : null}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---------- ConfirmDialog ---------- */

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A question that names the thing: "Delete Passport — Mom permanently?" */
  title: string;
  /** Plain consequence text, in the spec's permitted wording (§7.5). */
  body: ReactNode;
  /** The verb phrase again: "Delete permanently". Never "OK" or "Yes". */
  confirmLabel: string;
  onConfirm: () => void;
  cancelLabel?: string;
  /** Shows a checkbox that gates the danger button. The one sanctioned disabled state (Shred). */
  requireAcknowledge?: string;
  loading?: boolean;
  loadingLabel?: string;
}

/** For the irreversible only. Anything reversible gets an Undo toast instead. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  cancelLabel = "Cancel",
  requireAcknowledge,
  loading = false,
  loadingLabel,
}: ConfirmDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();

  const handleOpenChange = (next: boolean) => {
    if (!next) setAcknowledged(false);
    onOpenChange(next);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={scrim} />
        <Dialog.Content
          role="alertdialog"
          aria-describedby={bodyId}
          // land on Cancel, so Enter on a just-opened dialog can't destroy anything
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-[25rem] -translate-x-1/2 -translate-y-1/2",
            "flex-col gap-2.5 overflow-y-auto rounded-xl bg-surface px-5 pt-5.5 pb-4.5 shadow-float outline-none",
            "data-[state=open]:anim-dialog-in data-[state=closed]:anim-dialog-out",
          )}
        >
          <Dialog.Title className="text-heading">{title}</Dialog.Title>
          <div id={bodyId} className="text-callout text-ink-2">
            {body}
          </div>

          {requireAcknowledge && (
            <label className="mt-1 flex min-h-11 items-center gap-3 text-callout text-ink">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="size-5.5 shrink-0 accent-(--danger)"
              />
              <span>{requireAcknowledge}</span>
            </label>
          )}

          {/* stacked on phone with danger on top; side by side from 640 with Cancel on the left */}
          <div className="mt-2 flex flex-col gap-2 sm:flex-row-reverse">
            <Button
              variant="danger"
              size="md"
              className="w-full sm:flex-1"
              disabled={Boolean(requireAcknowledge) && !acknowledged}
              loading={loading}
              loadingLabel={loadingLabel}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
            <Dialog.Close asChild>
              <Button ref={cancelRef} variant="secondary" size="md" className="w-full sm:flex-1">
                {cancelLabel}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
