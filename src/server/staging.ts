import "server-only";
import type { BatchingProvider } from "@/vault/remote";
import type { StageItem } from "@/vault/remote";
import { store } from "./store";

/** The primary store, if it can stage blobs and commit several files at once. GitHub can; a folder can't. */
export async function batchingStore(): Promise<BatchingProvider | null> {
  const p = (await store()) as unknown as Partial<BatchingProvider>;
  return typeof p.stageBlob === "function" && typeof p.commitStaged === "function" ? (p as BatchingProvider) : null;
}

export const slotOf = (item: StageItem): string =>
  item.kind === "index" ? "index" : item.kind === "label" ? `label:${item.id}` : `part:${item.id}:${item.part}`;
