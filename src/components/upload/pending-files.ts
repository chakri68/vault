/**
 * Files on their way from a picker (or a drop, or the share sheet) to the
 * review screen. Held in memory only: a File can't go in a URL, and plaintext
 * waiting for encryption must never be parked in storage (§17.5).
 */
let pending: File[] = [];
const listeners = new Set<() => void>();

export function setPendingFiles(files: File[]): void {
  pending = files;
  for (const l of listeners) l();
}

export function takePendingFiles(): File[] {
  const out = pending;
  pending = [];
  return out;
}

export function peekPendingFiles(): File[] {
  return pending;
}

export function onPendingFiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
