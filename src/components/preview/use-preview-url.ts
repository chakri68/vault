"use client";

import { useEffect, useState } from "react";
import { useVault } from "@/client/vault-provider";

type Bytes = Uint8Array<ArrayBuffer>;

/**
 * A blob: URL for decrypted bytes, made through the vault's registry so that
 * locking revokes it no matter what state this component is in (§24). Revoked
 * as soon as the bytes change or the component goes away.
 */
export function usePreviewUrl(bytes: Bytes | null | undefined, mimeType: string | undefined): string | undefined {
  const { createPreviewUrl, revokePreviewUrl } = useVault();
  const [made, setMade] = useState<{ bytes: Bytes; url: string } | null>(null);

  useEffect(() => {
    if (!bytes || !mimeType) return;
    const url = createPreviewUrl(bytes, mimeType);
    let live = true;
    void Promise.resolve().then(() => { if (live) setMade({ bytes, url }); });
    return () => {
      live = false;
      revokePreviewUrl(url);
    };
  }, [bytes, mimeType, createPreviewUrl, revokePreviewUrl]);

  // a URL made for other bytes is already revoked: never hand it out
  return made && made.bytes === bytes ? made.url : undefined;
}
