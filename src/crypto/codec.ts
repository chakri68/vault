import { decode, encode } from "cborg";
import { type Bytes, asBytes } from "./bytes";

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out;
  }
  return value;
}

/** CBOR, not JSON-with-base64: no 33% tax, and cborg never reaches for eval (CSP). */
export function encodeCbor(value: unknown): Bytes {
  return asBytes(encode(stripUndefined(value)));
}

export function decodeCbor(data: Uint8Array): unknown {
  return decode(data);
}
