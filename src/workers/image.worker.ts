/// <reference lib="webworker" />
import { type OptimiseOptions, imageDimensions, optimiseImage, stripMetadata } from "@/compression/image";

/** Image work off the page's thread, so a 12-megapixel photo doesn't freeze the form it's being added from. */
type Bytes = Uint8Array<ArrayBuffer>;

export type ImageJob =
  | { id: number; op: "strip"; bytes: Bytes; mimeType: string }
  | { id: number; op: "optimise"; bytes: Bytes; mimeType: string; options?: OptimiseOptions }
  | { id: number; op: "dimensions"; bytes: Bytes; mimeType: string };

export type ImageJobResult =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<ImageJob>) => {
  const job = e.data;
  try {
    const result =
      job.op === "strip" ? await stripMetadata(job.bytes, job.mimeType)
      : job.op === "optimise" ? await optimiseImage(job.bytes, job.mimeType, job.options)
      : await imageDimensions(job.bytes, job.mimeType);
    const transfer = "bytes" in result ? [(result as { bytes: Bytes }).bytes.buffer] : [];
    scope.postMessage({ id: job.id, ok: true, result } satisfies ImageJobResult, transfer);
  } catch (err) {
    scope.postMessage({ id: job.id, ok: false, error: (err as Error)?.name ?? "Error" } satisfies ImageJobResult);
  }
};
