// WebCrypto wants ArrayBuffer-backed views (not SharedArrayBuffer), and TS ≥ 5.7
// makes that distinction in the type. Everything in src/crypto speaks this type.
export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function bytes(length: number): Bytes {
  return new Uint8Array(length);
}

export function randomBytes(length: number): Bytes {
  const out = bytes(length);
  // getRandomValues caps a single call at 65536 bytes
  for (let i = 0; i < length; i += 65536) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, length)));
  }
  return out;
}

/** Copies into a fresh ArrayBuffer-backed array. Accepts anything byte-like. */
export function toBytes(input: ArrayBuffer | ArrayBufferView): Bytes {
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  const view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const out = bytes(view.byteLength);
  out.set(view);
  return out;
}

/** Zero-copy when the input is already an exact ArrayBuffer-backed Uint8Array. */
export function asBytes(input: ArrayBuffer | ArrayBufferView): Bytes {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input.buffer instanceof ArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return toBytes(input);
}

export function concat(...chunks: Uint8Array[]): Bytes {
  const out = bytes(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function utf8(text: string): Bytes {
  return asBytes(encoder.encode(text));
}

export function fromUtf8(data: Uint8Array): string {
  return decoder.decode(data);
}

export function toHex(data: Uint8Array): string {
  let out = "";
  for (const b of data) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("invalid hex");
  const out = bytes(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(data: Uint8Array): string {
  let bin = "";
  // chunked so a multi-MB buffer doesn't blow the argument limit
  for (let i = 0; i < data.length; i += 0x8000) {
    bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function fromBase64(text: string): Bytes {
  const bin = atob(text);
  const out = bytes(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64Url(data: Uint8Array): string {
  return toBase64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Bytes {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

/** Length-independent-time comparison. Not for secrets of differing length. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function uuidToBytes(uuid: string): Bytes {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error("invalid uuid");
  return fromHex(hex);
}

export function bytesToUuid(data: Uint8Array): string {
  if (data.length !== 16) throw new Error("invalid uuid bytes");
  const h = toHex(data);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UUIDv4, not v7: a v7 id would put the upload time in a plaintext filename. */
export function newId(): string {
  return crypto.randomUUID();
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
