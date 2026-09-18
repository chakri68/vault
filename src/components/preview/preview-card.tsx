"use client";

import type { ReactNode } from "react";
import { type CatTint, cn } from "@/components/ui";

/**
 * The 176 px card at the top of a document: the category's tint, and either a
 * stylised page or — once the document has actually been opened — the picture.
 * Nothing is decrypted just to decorate this.
 */
export function PreviewCard({ cat, tag, imageUrl, onOpen, label }: {
  cat: CatTint;
  /** "PDF · 2 pages" */
  tag?: ReactNode;
  imageUrl?: string;
  onOpen?: () => void;
  /** accessible name when it opens the viewer: "Open Passport — Mom" */
  label?: string;
}) {
  const inner = (
    <>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a blob: URL of a decrypted document; the image optimiser must never see it
        <img src={imageUrl} alt="" className="size-full object-contain p-3" draggable={false} />
      ) : (
        <span aria-hidden className="grid h-[8.375rem] w-[13.25rem] max-w-[80%] grid-cols-[2.875rem_1fr] grid-rows-[1fr_auto] gap-x-3 gap-y-2 rounded-sm bg-surface p-3 shadow-[0_1px_2px_rgb(0_0_0/.08),0_6px_18px_rgb(0_0_0/.08)]">
          <span className="rounded-[0.25rem] bg-sunken" />
          <span className="flex flex-col gap-[0.4375rem] pt-0.5">
            {["w-[70%]", "w-[92%]", "w-[55%]", "w-[80%]"].map((w) => <i key={w} className={cn("block h-1.5 rounded-full bg-sunken", w)} />)}
          </span>
          <span className="col-span-2 flex flex-col gap-1">
            <i className="block h-1 w-full rounded-full bg-sunken" />
            <i className="block h-1 w-[86%] rounded-full bg-sunken" />
          </span>
        </span>
      )}
      {tag && (
        <span className="tabular absolute bottom-2.5 left-2.5 inline-flex min-h-[1.625rem] items-center rounded-full bg-surface px-2.5 text-footnote text-ink-2">
          {tag}
        </span>
      )}
    </>
  );
  const classes = "relative grid h-44 w-full flex-none place-items-center overflow-hidden rounded-lg bg-(--cat-bg)";
  if (!onOpen) return <div data-cat={cat} className={classes}>{inner}</div>;
  return (
    <button type="button" data-cat={cat} aria-label={label} onClick={onOpen}
      className={cn(classes, "transition-[filter] duration-150 ease-out active:brightness-[.97] active:duration-0")}>
      {inner}
    </button>
  );
}
