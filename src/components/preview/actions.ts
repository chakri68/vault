import type { OpenedDocument } from "./use-opened-document";

/** "Passport — Mom" + "pdf" → a name the OS will accept. The dash stays; slashes and friends don't. */
export function downloadName(name: string, extension: string): string {
  const stem = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() || "Document";
  return extension ? `${stem}.${extension}` : stem;
}

function asFile(doc: OpenedDocument, name: string): File {
  return new File([doc.content], downloadName(name, doc.header.extension), { type: doc.header.mimeType });
}

/**
 * §25: decrypted here, handed to the browser's own save. There is no server-side
 * download URL, and there can't be — the server has no key. The object URL is
 * untracked on purpose: it lives for one click and is revoked right after.
 */
export function downloadDocument(doc: OpenedDocument, name: string): void {
  const url = URL.createObjectURL(asFile(doc, name));
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName(name, doc.header.extension);
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function canShareFiles(): boolean {
  if (typeof navigator === "undefined" || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], "a.pdf", { type: "application/pdf" })] });
  } catch {
    return false;
  }
}

export type ShareOutcome = "shared" | "cancelled" | "downloaded" | "needs-tap";

/**
 * §26: the OS share sheet, after decrypting locally. Where the platform can't
 * share files, it falls back to a download. "needs-tap": the browser wants a
 * fresh tap because decrypting took longer than it's willing to remember the
 * last one; the document is opened by now, so the next tap is instant.
 */
export async function shareDocument(doc: OpenedDocument, name: string): Promise<ShareOutcome> {
  const file = asFile(doc, name);
  if (!navigator.canShare?.({ files: [file] })) {
    downloadDocument(doc, name);
    return "downloaded";
  }
  try {
    await navigator.share({ files: [file], title: name });
    return "shared";
  } catch (e) {
    const err = e as DOMException;
    if (err?.name === "AbortError") return "cancelled";
    if (err?.name === "NotAllowedError") return "needs-tap";
    downloadDocument(doc, name);
    return "downloaded";
  }
}

/** Shown once per session, not on every share (§26). Module-level: a reload is a new session, and starts locked anyway. */
let shareWarningSeen = false;
export const hasSeenShareWarning = () => shareWarningSeen;
export const markShareWarningSeen = () => { shareWarningSeen = true; };
