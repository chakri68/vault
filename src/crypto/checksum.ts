import { type Bytes, asBytes, toHex } from "./bytes";

/** Integrity only. Never leaves the device except inside encrypted metadata. */
export async function sha256(data: Bytes): Promise<Bytes> {
  return asBytes(await crypto.subtle.digest("SHA-256", data));
}

export async function sha256Hex(data: Bytes): Promise<string> {
  return toHex(await sha256(data));
}
