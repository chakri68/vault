import { type VaultIndex, VaultIndexSchema } from "@/schemas/index";
import { NONCE_LENGTH, TAG_LENGTH, KEY_LENGTH, importAesKey, open, seal } from "./aes";
import { type Bytes, bytes, concat, randomBytes, utf8 } from "./bytes";
import { decodeCbor, encodeCbor } from "./codec";
import { ContainerFormatError } from "./container";

/**
 * index.vault:
 *
 *   magic "FVIX" 4 | version u16
 *   wrappedKeyNonce 12 | wrappedIndexKey 48
 *   nonce 12 | ciphertext (CBOR VaultIndex)
 *
 * §4.2: a fresh index key on every write. The index is rewritten constantly;
 * the VMK only ever encrypts 32-byte keys, so its GCM usage stays tiny.
 */
const MAGIC = utf8("FVIX");
const VERSION = 1;
const WRAPPED_KEY_LENGTH = KEY_LENGTH + TAG_LENGTH;
const PREFIX = 4 + 2 + NONCE_LENGTH + WRAPPED_KEY_LENGTH + NONCE_LENGTH;

const KEY_CONTEXT = "fv:index-key";
const DATA_CONTEXT = "fv:index";

export async function sealIndex(vmk: CryptoKey, index: VaultIndex): Promise<Bytes> {
  const rawKey = randomBytes(KEY_LENGTH);
  const indexKey = await importAesKey(rawKey);
  const wrapped = await seal(vmk, rawKey, KEY_CONTEXT);
  rawKey.fill(0);
  const sealed = await seal(indexKey, encodeCbor(index), DATA_CONTEXT);

  const prefix = bytes(PREFIX);
  let o = 0;
  prefix.set(MAGIC, o); o += 4;
  new DataView(prefix.buffer).setUint16(o, VERSION); o += 2;
  prefix.set(wrapped.nonce, o); o += NONCE_LENGTH;
  prefix.set(wrapped.ciphertext, o); o += WRAPPED_KEY_LENGTH;
  prefix.set(sealed.nonce, o);
  return concat(prefix, sealed.ciphertext);
}

export async function openIndex(vmk: CryptoKey, data: Bytes): Promise<VaultIndex> {
  if (data.length < PREFIX + TAG_LENGTH) throw new ContainerFormatError("index too short");
  for (let i = 0; i < 4; i++) if (data[i] !== MAGIC[i]) throw new ContainerFormatError("bad index magic");
  let o = 4;
  const version = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(o); o += 2;
  if (version !== VERSION) throw new ContainerFormatError("unsupported index version");
  const keyNonce = data.subarray(o, o + NONCE_LENGTH) as Bytes; o += NONCE_LENGTH;
  const keyCiphertext = data.subarray(o, o + WRAPPED_KEY_LENGTH) as Bytes; o += WRAPPED_KEY_LENGTH;
  const nonce = data.subarray(o, o + NONCE_LENGTH) as Bytes; o += NONCE_LENGTH;

  const rawKey = await open(vmk, keyNonce, keyCiphertext, KEY_CONTEXT);
  const indexKey = await importAesKey(rawKey);
  rawKey.fill(0);
  const plain = await open(indexKey, nonce, data.subarray(o) as Bytes, DATA_CONTEXT);
  return VaultIndexSchema.parse(decodeCbor(plain));
}
