import type { ImageJob, ImageJobResult } from "@/workers/image.worker";
import {
  ImageDecodeError, type OptimiseOptions, type ProcessedImage,
  imageDimensions as dimensionsHere, optimiseImage as optimiseHere, stripMetadata as stripHere,
} from "./image";

type Bytes = Uint8Array<ArrayBuffer>;
type Job = ImageJob extends infer J ? (J extends { id: number } ? Omit<J, "id"> : never) : never;

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** Starts the image worker early, so its script is in the offline shell before it's needed. */
export function warmImageWorker(): void {
  getWorker();
}

function getWorker(): Worker | null {
  // No OffscreenCanvas in workers (older Safari): do it on the page instead.
  if (broken || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("../workers/image.worker.ts", import.meta.url), { type: "module", name: "image" });
    worker.onmessage = (e: MessageEvent<ImageJobResult>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.ok) w.resolve(e.data.result);
      else w.reject(e.data.error === "ImageDecodeError" ? new ImageDecodeError() : new Error(e.data.error));
    };
    worker.onerror = () => {
      broken = true;
      for (const w of waiting.values()) w.reject(new Error("image worker failed"));
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    broken = true;
    return null;
  }
}

function run<T>(job: Job, here: () => Promise<T>): Promise<T> {
  const w = getWorker();
  if (!w) return here();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    // a copy crosses over: the caller keeps the original, which may still be the one that gets saved
    w.postMessage({ ...job, id });
  }).catch((e) => {
    if (e instanceof ImageDecodeError) throw e;
    return here(); // the worker let us down; the page can still do it
  });
}

export const stripMetadata = (bytes: Bytes, mimeType: string): Promise<ProcessedImage> =>
  run({ op: "strip", bytes, mimeType }, () => stripHere(bytes, mimeType));

export const optimiseImage = (bytes: Bytes, mimeType: string, options?: OptimiseOptions): Promise<ProcessedImage> =>
  run({ op: "optimise", bytes, mimeType, options }, () => optimiseHere(bytes, mimeType, options));

export const imageDimensions = (bytes: Bytes, mimeType: string): Promise<{ width: number; height: number }> =>
  run({ op: "dimensions", bytes, mimeType }, () => dimensionsHere(bytes, mimeType));

export { ImageDecodeError, isProcessableImage, type ProcessedImage } from "./image";
