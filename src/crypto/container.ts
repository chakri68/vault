import { type ObjectHeader, ObjectHeaderSchema } from "@/schemas/file";
import { NONCE_LENGTH, TAG_LENGTH, KEY_LENGTH, importAesKey, open, seal } from "./aes";
import { type Bytes, bytes, bytesToUuid, concat, randomBytes, utf8, uuidToBytes } from "./bytes";
import { decodeCbor, encodeCbor } from "./codec";
import { pad, padMeta, paddedLength, unpad, unpadMeta } from "./padding";

/**
 * §4.5 object container, v1.
 *
 *   magic "FVLT"        4
 *   formatVersion       u16
 *   flags               u16
 *   objectId            16   (UUIDv4, raw)
 *   partCount           u16  (how many storage parts the container was split into)
 *   wrappedKeyNonce     12
 *   wrappedFileKey      48   (32 + tag), AES-GCM under the VMK
 *   headerNonce         12
 *   headerLength        u32
 *   headerCiphertext    …    (CBOR, padded to 4 KB steps, under the file key)
 *   contentNonce        12
 *   contentCiphertext   …    (content padded to a size bucket, under the file key)
 *
 * partCount is the one deviation from the spec's layout: hosts like Vercel cap
 * request bodies around 4.5 MB, so a big container is stored as several parts
 * and part 0 has to say how many siblings to fetch.
 */
export const MAGIC = utf8("FVLT");
export const FORMAT_VERSION = 1;
const WRAPPED_KEY_LENGTH = KEY_LENGTH + TAG_LENGTH;
const FIXED_PREFIX = 4 + 2 + 2 + 16 + 2 + NONCE_LENGTH + WRAPPED_KEY_LENGTH + NONCE_LENGTH + 4;

/** 4 MiB keeps every request under the smallest body limit we expect to meet. */
export const PART_SIZE = 4 * 1024 * 1024;
export const MAX_PARTS = 64;

export class ContainerFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerFormatError";
  }
}

// AAD contexts: a ciphertext lifted out of one object can't be opened as part of another.
const ctx = {
  key: (id: string) => `fv:object-key:${id}`,
  header: (id: string) => `fv:object-header:${id}`,
  content: (id: string) => `fv:object-content:${id}`,
};

export interface SealedObject {
  id: string;
  parts: Bytes[];
  encryptedSize: number;
  /** the file key wrapped under the VMK, reused by the sidecar */
  wrappedKey: { nonce: Bytes; ciphertext: Bytes };
  fileKey: CryptoKey;
}

export function splitParts(container: Bytes, partSize = PART_SIZE): Bytes[] {
  const parts: Bytes[] = [];
  for (let o = 0; o < container.length; o += partSize) {
    parts.push(container.subarray(o, Math.min(o + partSize, container.length)) as Bytes);
  }
  return parts;
}

export function partCountFor(totalLength: number, partSize = PART_SIZE): number {
  return Math.max(1, Math.ceil(totalLength / partSize));
}

export async function sealObject(
  vmk: CryptoKey,
  header: ObjectHeader,
  content: Bytes,
  partSize = PART_SIZE,
): Promise<SealedObject> {
  if (content.length !== header.plaintextSize) throw new Error("header.plaintextSize mismatch");
  const id = header.id;

  const rawFileKey = randomBytes(KEY_LENGTH);
  const fileKey = await importAesKey(rawFileKey);
  const wrappedKey = await seal(vmk, rawFileKey, ctx.key(id));
  rawFileKey.fill(0);

  const sealedHeader = await seal(fileKey, padMeta(encodeCbor(header)), ctx.header(id));
  const sealedContent = await seal(fileKey, pad(content), ctx.content(id));

  const total =
    FIXED_PREFIX + sealedHeader.ciphertext.length + NONCE_LENGTH + sealedContent.ciphertext.length;
  const partCount = partCountFor(total, partSize);
  if (partCount > MAX_PARTS) throw new Error("object too large");

  const fixed = bytes(FIXED_PREFIX);
  const view = new DataView(fixed.buffer);
  let o = 0;
  fixed.set(MAGIC, o); o += 4;
  view.setUint16(o, FORMAT_VERSION); o += 2;
  view.setUint16(o, 0); o += 2;
  fixed.set(uuidToBytes(id), o); o += 16;
  view.setUint16(o, partCount); o += 2;
  fixed.set(wrappedKey.nonce, o); o += NONCE_LENGTH;
  fixed.set(wrappedKey.ciphertext, o); o += WRAPPED_KEY_LENGTH;
  fixed.set(sealedHeader.nonce, o); o += NONCE_LENGTH;
  view.setUint32(o, sealedHeader.ciphertext.length);

  const container = concat(fixed, sealedHeader.ciphertext, sealedContent.nonce, sealedContent.ciphertext);
  return { id, parts: splitParts(container, partSize), encryptedSize: container.length, wrappedKey, fileKey };
}

export interface ContainerPrefix {
  formatVersion: number;
  flags: number;
  id: string;
  partCount: number;
  wrappedKey: { nonce: Bytes; ciphertext: Bytes };
  headerNonce: Bytes;
  headerCiphertext: Bytes;
  /** offset of contentNonce within the whole container */
  contentOffset: number;
}

/** Parses the unencrypted prefix. Works on part 0 alone; the header always fits in it. */
export function parsePrefix(data: Bytes): ContainerPrefix {
  if (data.length < FIXED_PREFIX) throw new ContainerFormatError("too short");
  for (let i = 0; i < 4; i++) if (data[i] !== MAGIC[i]) throw new ContainerFormatError("bad magic");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 4;
  const formatVersion = view.getUint16(o); o += 2;
  if (formatVersion !== FORMAT_VERSION) throw new ContainerFormatError("unsupported format version");
  const flags = view.getUint16(o); o += 2;
  const id = bytesToUuid(data.subarray(o, o + 16)); o += 16;
  const partCount = view.getUint16(o); o += 2;
  if (partCount < 1 || partCount > MAX_PARTS) throw new ContainerFormatError("bad part count");
  const keyNonce = data.subarray(o, o + NONCE_LENGTH) as Bytes; o += NONCE_LENGTH;
  const keyCiphertext = data.subarray(o, o + WRAPPED_KEY_LENGTH) as Bytes; o += WRAPPED_KEY_LENGTH;
  const headerNonce = data.subarray(o, o + NONCE_LENGTH) as Bytes; o += NONCE_LENGTH;
  const headerLength = view.getUint32(o); o += 4;
  if (headerLength < TAG_LENGTH || o + headerLength > data.length) {
    throw new ContainerFormatError("bad header length");
  }
  const headerCiphertext = data.subarray(o, o + headerLength) as Bytes;
  return {
    formatVersion, flags, id, partCount,
    wrappedKey: { nonce: keyNonce, ciphertext: keyCiphertext },
    headerNonce, headerCiphertext,
    contentOffset: o + headerLength,
  };
}

export async function unwrapFileKey(
  vmk: CryptoKey,
  id: string,
  wrapped: { nonce: Bytes; ciphertext: Bytes },
): Promise<CryptoKey> {
  const raw = await open(vmk, wrapped.nonce, wrapped.ciphertext, ctx.key(id));
  try {
    return await importAesKey(raw);
  } finally {
    raw.fill(0);
  }
}

/** Decrypts just the label on the file. Needs part 0 only. */
export async function openHeader(
  vmk: CryptoKey,
  part0: Bytes,
): Promise<{ header: ObjectHeader; prefix: ContainerPrefix; fileKey: CryptoKey }> {
  const prefix = parsePrefix(part0);
  const fileKey = await unwrapFileKey(vmk, prefix.id, prefix.wrappedKey);
  const plain = await open(fileKey, prefix.headerNonce, prefix.headerCiphertext, ctx.header(prefix.id));
  const header = ObjectHeaderSchema.parse(decodeCbor(unpadMeta(plain)));
  if (header.id !== prefix.id) throw new ContainerFormatError("header id mismatch");
  return { header, prefix, fileKey };
}

export async function openObject(
  vmk: CryptoKey,
  parts: Bytes[],
): Promise<{ header: ObjectHeader; content: Bytes }> {
  const container = parts.length === 1 ? parts[0] : concat(...parts);
  const { header, prefix, fileKey } = await openHeader(vmk, container);
  if (parts.length !== prefix.partCount) throw new ContainerFormatError("missing parts");
  let o = prefix.contentOffset;
  if (o + NONCE_LENGTH + TAG_LENGTH > container.length) throw new ContainerFormatError("truncated");
  const nonce = container.subarray(o, o + NONCE_LENGTH) as Bytes; o += NONCE_LENGTH;
  const padded = await open(fileKey, nonce, container.subarray(o) as Bytes, ctx.content(prefix.id));
  if (padded.length !== paddedLength(header.plaintextSize)) {
    throw new ContainerFormatError("padding mismatch");
  }
  return { header, content: unpad(padded, header.plaintextSize) };
}
