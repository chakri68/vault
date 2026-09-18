import { type Sidecar, SidecarSchema } from "@/schemas/file";
import { NONCE_LENGTH, TAG_LENGTH, KEY_LENGTH, open, seal } from "./aes";
import { type Bytes, bytes, bytesToUuid, concat, utf8, uuidToBytes } from "./bytes";
import { decodeCbor, encodeCbor } from "./codec";
import { ContainerFormatError, unwrapFileKey } from "./container";
import { padMeta, unpadMeta } from "./padding";

/**
 * The sidecar, `objects/<id>.meta.vault`: the editable label on a document.
 *
 *   magic "FVMD" 4 | version u16 | objectId 16
 *   wrappedKeyNonce 12 | wrappedFileKey 48      (same wrap as the content object)
 *   nonce 12 | ciphertext (CBOR Sidecar, padded to 4 KB steps, under the file key)
 *
 * Why it exists: the header inside the content object is sealed at upload and
 * the object is never rewritten, so a rename has nowhere authoritative to live
 * except the index — and the index is a cache that Repair rebuilds. The sidecar
 * is that place. It carries its own copy of the wrapped file key, so a rebuild
 * reads a couple of KB per document, not the document.
 */
const MAGIC = utf8("FVMD");
const VERSION = 1;
const WRAPPED_KEY_LENGTH = KEY_LENGTH + TAG_LENGTH;
const PREFIX = 4 + 2 + 16 + NONCE_LENGTH + WRAPPED_KEY_LENGTH + NONCE_LENGTH;

const context = (id: string) => `fv:object-sidecar:${id}`;

export async function sealSidecar(
  fileKey: CryptoKey,
  wrappedKey: { nonce: Bytes; ciphertext: Bytes },
  sidecar: Sidecar,
): Promise<Bytes> {
  const id = sidecar.facts.id;
  const sealed = await seal(fileKey, padMeta(encodeCbor(sidecar)), context(id));
  const prefix = bytes(PREFIX);
  let o = 0;
  prefix.set(MAGIC, o); o += 4;
  new DataView(prefix.buffer).setUint16(o, VERSION); o += 2;
  prefix.set(uuidToBytes(id), o); o += 16;
  prefix.set(wrappedKey.nonce, o); o += NONCE_LENGTH;
  prefix.set(wrappedKey.ciphertext, o); o += WRAPPED_KEY_LENGTH;
  prefix.set(sealed.nonce, o);
  return concat(prefix, sealed.ciphertext);
}

export interface OpenedSidecar {
  sidecar: Sidecar;
  fileKey: CryptoKey;
  wrappedKey: { nonce: Bytes; ciphertext: Bytes };
}

export async function openSidecar(vmk: CryptoKey, data: Bytes): Promise<OpenedSidecar> {
  if (data.length < PREFIX + TAG_LENGTH) throw new ContainerFormatError("sidecar too short");
  for (let i = 0; i < 4; i++) if (data[i] !== MAGIC[i]) throw new ContainerFormatError("bad sidecar magic");
  let o = 4;
  const version = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(o); o += 2;
  if (version !== VERSION) throw new ContainerFormatError("unsupported sidecar version");
  const id = bytesToUuid(data.subarray(o, o + 16)); o += 16;
  const wrappedKey = {
    nonce: data.slice(o, o + NONCE_LENGTH) as Bytes,
    ciphertext: data.slice(o + NONCE_LENGTH, o + NONCE_LENGTH + WRAPPED_KEY_LENGTH) as Bytes,
  };
  o += NONCE_LENGTH + WRAPPED_KEY_LENGTH;
  const nonce = data.subarray(o, o + NONCE_LENGTH) as Bytes; o += NONCE_LENGTH;
  const fileKey = await unwrapFileKey(vmk, id, wrappedKey);
  const plain = await open(fileKey, nonce, data.subarray(o) as Bytes, context(id));
  const sidecar = SidecarSchema.parse(decodeCbor(unpadMeta(plain)));
  if (sidecar.facts.id !== id) throw new ContainerFormatError("sidecar id mismatch");
  return { sidecar, fileKey, wrappedKey };
}
