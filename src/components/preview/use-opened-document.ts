"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVault } from "@/client/vault-provider";
import type { ObjectHeader } from "@/schemas/file";

type Bytes = Uint8Array<ArrayBuffer>;

export interface OpenedDocument {
  header: ObjectHeader;
  content: Bytes;
}

export type OpenProblem = "integrity" | "offline" | "error";

/**
 * Decrypts a document at most once per visit to its screen, and shares the
 * result between the viewer, Share and Download. The plaintext lives in this
 * hook's memory only: leaving the screen, or locking, drops it.
 */
export function useOpenedDocument(id: string) {
  const { rpc } = useVault();
  const cache = useRef<OpenedDocument | null>(null);
  const inflight = useRef<Promise<OpenedDocument | null> | null>(null);
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<OpenProblem | null>(null);
  const [opened, setOpened] = useState<OpenedDocument | null>(null);

  // Callers key the screen on the id, and locking unmounts everything under the
  // gate, so "forget" is simply: drop the references when this goes away.
  useEffect(() => () => {
    cache.current = null;
    inflight.current = null;
  }, []);

  const open = useCallback((): Promise<OpenedDocument | null> => {
    if (cache.current) return Promise.resolve(cache.current);
    if (inflight.current) return inflight.current;
    setOpening(true);
    setProblem(null);
    const run = rpc.openDocument(id).then(
      (doc) => {
        cache.current = doc;
        setOpened(doc);
        return doc;
      },
      (e: { name?: string }) => {
        setProblem(e?.name === "IntegrityError" ? "integrity" : e?.name === "OfflineError" ? "offline" : "error");
        return null;
      },
    ).finally(() => {
      inflight.current = null;
      setOpening(false);
    });
    inflight.current = run;
    return run;
  }, [rpc, id]);

  return { open, opened, opening, problem, clearProblem: () => setProblem(null) };
}
