import "server-only";
import type { NextRequest } from "next/server";
import { UUID_RE } from "@/crypto/bytes";
import { MAX_PARTS } from "@/crypto/container";
import { ApiError } from "./api";

/**
 * Which object a request is about travels in a header, never in the URL. Hosts
 * log URLs. With the id in the path, an access log becomes a per-document read
 * history — more than the "when was the store written" the design concedes
 * (§3.2, §40.10). Every object route has one constant URL instead.
 */
export function objectTarget(req: NextRequest): { id: string; part: number } {
  const id = req.headers.get("x-fv-object") ?? "";
  if (!UUID_RE.test(id)) throw new ApiError(400, "bad-request");
  const raw = req.headers.get("x-fv-part") ?? "0";
  const part = Number(raw);
  if (!/^\d{1,2}$/.test(raw) || part >= MAX_PARTS) throw new ApiError(400, "bad-request");
  return { id, part };
}
