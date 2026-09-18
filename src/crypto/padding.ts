import { type Bytes, bytes } from "./bytes";

const KB = 1024;
const MB = 1024 * KB;
const BUCKETS = [16 * KB, 64 * KB, 256 * KB, 1 * MB];

/** §4.7: collapse the size side-channel to a handful of buckets. */
export function paddedLength(length: number): number {
  if (!Number.isInteger(length) || length < 0) throw new Error("invalid length");
  for (const b of BUCKETS) if (length <= b) return b;
  return Math.ceil(length / MB) * MB;
}

/** Zero-fill. It's encrypted afterwards, so the fill pattern is irrelevant. */
export function pad(data: Uint8Array, target = paddedLength(data.length)): Bytes {
  if (target < data.length) throw new Error("pad target smaller than data");
  const out = bytes(target);
  out.set(data);
  return out;
}

export function unpad(data: Bytes, trueLength: number): Bytes {
  if (!Number.isInteger(trueLength) || trueLength < 0 || trueLength > data.length) {
    throw new Error("invalid true length");
  }
  return data.subarray(0, trueLength) as Bytes;
}

const META_BUCKET = 4 * KB;

/**
 * Metadata blobs (object header, sidecar) pad to 4 KB steps with a length
 * prefix. 4 KB, not 1: a name, a handful of tags and a generous note all fit in
 * one step, so "this one has a long note" doesn't show in the ciphertext size.
 */
export function padMeta(data: Uint8Array): Bytes {
  const total = Math.ceil((4 + data.length) / META_BUCKET) * META_BUCKET;
  const out = bytes(total);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}

export function unpadMeta(data: Bytes): Bytes {
  if (data.length < 4) throw new Error("metadata too short");
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (length > data.length - 4) throw new Error("metadata length out of range");
  return data.subarray(4, 4 + length) as Bytes;
}
