import { describe, expect, it } from "vitest";
import type { ObjectHeader } from "@/schemas/file";
import { emptyIndex } from "@/vault/index-model";
import { DecryptError, importAesKey, open, seal } from "./aes";
import { type Bytes, concat, equalBytes, newId, randomBytes, toBase64, toHex, utf8 } from "./bytes";
import { sha256Hex } from "./checksum";
import { ContainerFormatError, openHeader, openObject, parsePrefix, sealObject } from "./container";
import {
  createPasswordEnvelope, createPrfEnvelope, createRecoveryEnvelope, derivePasswordKeys,
  derivePrfWrappingKey, deriveRecoveryKeys, deriveWriteAuthKey, generateVmk, openLabel, sealLabel, unwrapVmk,
} from "./envelopes";
import { INFO, hkdf } from "./hkdf";
import { openIndex, sealIndex } from "./index-file";
import { assertSaneKdf, DEFAULT_KDF } from "./kdf";
import { pad, padMeta, paddedLength, unpad, unpadMeta } from "./padding";
import {
  ALPHABET, formatRecoveryCode, generateRecoveryCode, groupsOf, parseRecoveryCode,
} from "./recovery-code";
import { openSidecar, sealSidecar } from "./sidecar";
import { fromBase64 } from "./bytes";

const KB = 1024;
const MB = KB * KB;

function header(content: Bytes, over: Partial<ObjectHeader> = {}): ObjectHeader {
  const now = new Date().toISOString();
  return {
    version: 1, id: newId(), name: "Passport — Mom", extension: "pdf", mimeType: "application/pdf",
    plaintextSize: content.length, checksum: "0".repeat(64), ownerProfileIds: ["mom"], tags: ["travel"],
    createdAt: now, updatedAt: now, ...over,
  };
}

describe("aes-gcm", () => {
  it("round-trips", async () => {
    const key = await importAesKey(randomBytes(32));
    const sealed = await seal(key, utf8("hello"), "ctx");
    expect(new TextDecoder().decode(await open(key, sealed.nonce, sealed.ciphertext, "ctx"))).toBe("hello");
  });

  it("rejects the wrong key, a wrong context, and any tampering — all the same way", async () => {
    const key = await importAesKey(randomBytes(32));
    const other = await importAesKey(randomBytes(32));
    const sealed = await seal(key, utf8("hello"), "ctx");

    await expect(open(other, sealed.nonce, sealed.ciphertext, "ctx")).rejects.toBeInstanceOf(DecryptError);
    await expect(open(key, sealed.nonce, sealed.ciphertext, "other")).rejects.toBeInstanceOf(DecryptError);
    for (let i = 0; i < sealed.ciphertext.length; i++) {
      const bad = sealed.ciphertext.slice() as Bytes;
      bad[i] ^= 1;
      await expect(open(key, sealed.nonce, bad, "ctx")).rejects.toBeInstanceOf(DecryptError);
    }
    const errors = await Promise.all([
      open(other, sealed.nonce, sealed.ciphertext, "ctx").catch((e: Error) => e.message),
      open(key, sealed.nonce, sealed.ciphertext, "x").catch((e: Error) => e.message),
    ]);
    expect(new Set(errors).size).toBe(1); // no oracle in the error text
  });

  it("never repeats a nonce", async () => {
    const key = await importAesKey(randomBytes(32));
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(toHex((await seal(key, utf8("x"), "c")).nonce));
    expect(seen.size).toBe(5000);
  });
});

describe("hkdf domain separation", () => {
  it("derives unrelated keys from one secret", async () => {
    const secret = randomBytes(32);
    const salt = randomBytes(32);
    const all = await Promise.all(Object.values(INFO).map((info) => hkdf(secret, info, salt)));
    expect(new Set(all.map(toHex)).size).toBe(all.length);
  });

  it("the auth secret is never the wrapping key", async () => {
    const salt = randomBytes(32);
    const p = await derivePasswordKeys("mango tree monsoon kettle", salt, { ...DEFAULT_KDF, memory: 19 * 1024, iterations: 2 });
    expect(equalBytes(p.authSecret, p.wrappingKey)).toBe(false);
    const r = await deriveRecoveryKeys("K7QM4X2P9WBNT3RV8HFD2NAC6JYE5MSZ", salt);
    expect(equalBytes(r.authSecret, r.wrappingKey)).toBe(false);
    expect(equalBytes(p.authSecret, r.authSecret)).toBe(false);
  });

  it("refuses KDF parameters too weak or too heavy to be real", () => {
    expect(() => assertSaneKdf({ ...DEFAULT_KDF, memory: 8 })).toThrow();
    expect(() => assertSaneKdf({ ...DEFAULT_KDF, iterations: 1 })).toThrow();
    expect(() => assertSaneKdf({ ...DEFAULT_KDF, memory: 64 * MB })).toThrow();
    expect(() => assertSaneKdf(DEFAULT_KDF)).not.toThrow();
  });
});

describe("padding", () => {
  it("lands every size in the right bucket, at and around each boundary", () => {
    const cases: Array<[number, number]> = [
      [0, 16 * KB], [1, 16 * KB], [16 * KB, 16 * KB], [16 * KB + 1, 64 * KB],
      [64 * KB, 64 * KB], [64 * KB + 1, 256 * KB], [256 * KB, 256 * KB], [256 * KB + 1, MB],
      [MB, MB], [MB + 1, 2 * MB], [2 * MB, 2 * MB], [2 * MB + 1, 3 * MB], [49 * MB + 7, 50 * MB],
    ];
    for (const [n, want] of cases) expect(paddedLength(n), `${n}`).toBe(want);
  });

  it("pads and unpads without touching the content", () => {
    for (const n of [0, 1, 16 * KB - 1, 16 * KB, 16 * KB + 1, 100_000]) {
      const data = randomBytes(n);
      const padded = pad(data);
      expect(padded.length).toBe(paddedLength(n));
      expect(equalBytes(unpad(padded, n), data)).toBe(true);
    }
    expect(() => unpad(pad(randomBytes(10)), 20 * KB)).toThrow();
  });

  it("pads metadata to 4 KB steps", () => {
    for (const n of [0, 1, 4091, 4092, 4093, 9000]) {
      const data = randomBytes(n);
      const padded = padMeta(data);
      expect(padded.length % (4 * KB)).toBe(0);
      expect(padded.length).toBe(Math.ceil((n + 4) / (4 * KB)) * 4 * KB);
      expect(equalBytes(unpadMeta(padded), data)).toBe(true);
    }
  });
});

describe("object container", () => {
  it("round-trips content and header", async () => {
    const vmk = await importAesKey(generateVmk());
    const content = randomBytes(3000);
    const h = header(content, { checksum: await sha256Hex(content), note: "renew in 2031" });
    const sealed = await sealObject(vmk, h, content);
    expect(sealed.parts).toHaveLength(1);
    const opened = await openObject(vmk, sealed.parts);
    expect(opened.header).toEqual(h);
    expect(equalBytes(opened.content, content)).toBe(true);
  });

  it("a 3 KB text file and a 14 KB image are the same size in the store (§40.11)", async () => {
    const vmk = await importAesKey(generateVmk());
    const a = randomBytes(3 * KB);
    const b = randomBytes(14 * KB);
    const sa = await sealObject(vmk, header(a, { name: "Note", note: "x".repeat(900), tags: ["a", "b", "c"] }), a);
    const sb = await sealObject(vmk, header(b, { name: "Passport photo — Dad" }), b);
    expect(sa.encryptedSize).toBe(sb.encryptedSize);
  });

  it("contains nothing readable", async () => {
    const vmk = await importAesKey(generateVmk());
    const content = utf8("AADHAAR 1234 5678 9012 ".repeat(50));
    const sealed = await sealObject(vmk, header(content, { name: "Aadhaar — Chakri" }), content);
    const text = new TextDecoder("latin1").decode(sealed.parts[0]);
    for (const needle of ["Aadhaar", "Chakri", "AADHAAR", "application/pdf", "mom", "travel"]) {
      expect(text.includes(needle), needle).toBe(false);
    }
  });

  it("splits into parts and reassembles", async () => {
    const vmk = await importAesKey(generateVmk());
    const content = randomBytes(200 * KB);
    const sealed = await sealObject(vmk, header(content), content, 64 * KB);
    expect(sealed.parts.length).toBe(Math.ceil(sealed.encryptedSize / (64 * KB)));
    expect(parsePrefix(sealed.parts[0]).partCount).toBe(sealed.parts.length);
    expect(equalBytes((await openObject(vmk, sealed.parts)).content, content)).toBe(true);
    await expect(openObject(vmk, sealed.parts.slice(0, -1))).rejects.toBeInstanceOf(ContainerFormatError);
  });

  it("reads the header from part 0 alone", async () => {
    const vmk = await importAesKey(generateVmk());
    const content = randomBytes(200 * KB);
    const h = header(content);
    const sealed = await sealObject(vmk, h, content, 64 * KB);
    expect((await openHeader(vmk, sealed.parts[0])).header.name).toBe(h.name);
  });

  it("fails loudly on a wrong key or a flipped bit, anywhere", async () => {
    const vmk = await importAesKey(generateVmk());
    const content = randomBytes(500);
    const sealed = await sealObject(vmk, header(content), content);
    await expect(openObject(await importAesKey(generateVmk()), sealed.parts)).rejects.toBeInstanceOf(DecryptError);

    const whole = sealed.parts[0];
    for (const offset of [30, 60, 100, 200, whole.length - 1, whole.length - 5000]) {
      const bad = whole.slice() as Bytes;
      bad[offset] ^= 0x01;
      await expect(openObject(vmk, [bad])).rejects.toThrow();
    }
  });

  it("rejects malformed input without crashing", async () => {
    const vmk = await importAesKey(generateVmk());
    const content = randomBytes(10);
    const good = (await sealObject(vmk, header(content), content)).parts[0];
    const cases: Bytes[] = [
      new Uint8Array(0), randomBytes(3), randomBytes(200), good.subarray(0, 50) as Bytes,
      concat(utf8("NOPE"), good.subarray(4)), good.subarray(0, 120) as Bytes,
    ];
    for (const c of cases) await expect(openObject(vmk, [c])).rejects.toThrow();
    const badVersion = good.slice() as Bytes; badVersion[5] = 9;
    expect(() => parsePrefix(badVersion)).toThrow(ContainerFormatError);
    const badLength = good.slice() as Bytes; new DataView(badLength.buffer).setUint32(98, 0xffffffff);
    expect(() => parsePrefix(badLength)).toThrow(ContainerFormatError);
  });

  it("won't open one object's ciphertext as another's", async () => {
    const vmk = await importAesKey(generateVmk());
    const content = randomBytes(10);
    const a = (await sealObject(vmk, header(content), content)).parts[0];
    const b = (await sealObject(vmk, header(content), content)).parts[0];
    // graft b's id onto a
    const forged = a.slice() as Bytes;
    forged.set(b.subarray(8, 24), 8);
    await expect(openObject(vmk, [forged])).rejects.toBeInstanceOf(DecryptError);
  });
});

describe("sidecar and index", () => {
  it("sidecar round-trips and unwraps with the VMK alone", async () => {
    const vmk = await importAesKey(generateVmk());
    const content = randomBytes(10);
    const h = header(content);
    const sealed = await sealObject(vmk, h, content);
    const sidecar = {
      version: 1 as const,
      facts: { id: h.id, extension: "pdf", mimeType: "application/pdf", plaintextSize: 10, checksum: h.checksum, createdAt: h.createdAt },
      meta: { name: "Renamed", ownerProfileIds: ["mom"], tags: [] },
      fieldVersions: { name: 5 }, encryptedSize: sealed.encryptedSize, partCount: 1, updatedAt: h.updatedAt,
    };
    const bytes = await sealSidecar(sealed.fileKey, sealed.wrappedKey, sidecar);
    // 94-byte prefix + 16-byte tag around a payload padded to 4 KB steps
    expect((bytes.length - 94 - 16) % (4 * KB)).toBe(0);
    expect((await openSidecar(vmk, bytes)).sidecar).toEqual(sidecar);
    await expect(openSidecar(await importAesKey(generateVmk()), bytes)).rejects.toBeInstanceOf(DecryptError);
  });

  it("index round-trips under a fresh key every time", async () => {
    const vmk = await importAesKey(generateVmk());
    const index = emptyIndex();
    const a = await sealIndex(vmk, index);
    const b = await sealIndex(vmk, index);
    expect(equalBytes(a, b)).toBe(false);
    expect(toHex(a.subarray(18, 66))).not.toBe(toHex(b.subarray(18, 66))); // different wrapped index keys
    expect(await openIndex(vmk, a)).toEqual(index);
    await expect(openIndex(await importAesKey(generateVmk()), a)).rejects.toBeInstanceOf(DecryptError);
    await expect(openIndex(vmk, randomBytes(40))).rejects.toThrow();
  });
});

describe("recovery code", () => {
  it("is 8 groups of 4 from the Crockford alphabet, with a working check symbol", async () => {
    for (let i = 0; i < 50; i++) {
      const code = await generateRecoveryCode();
      expect(code).toHaveLength(32);
      for (const ch of code) expect(ALPHABET.includes(ch)).toBe(true);
      expect(/[ILOU]/.test(code)).toBe(false);
      expect(groupsOf(code)).toHaveLength(8);
      expect(await parseRecoveryCode(formatRecoveryCode(code))).toEqual({ ok: true, code });
    }
  });

  it("forgives handwriting and formatting, catches typos", async () => {
    const code = await generateRecoveryCode();
    const sloppy = formatRecoveryCode(code).toLowerCase().replace(/0/g, "o").replace(/1/g, "l").replace(/ /g, "-");
    expect(await parseRecoveryCode(sloppy)).toEqual({ ok: true, code });

    expect(await parseRecoveryCode(code.slice(1))).toEqual({ ok: false, problem: "length" });
    expect(await parseRecoveryCode("U" + code.slice(1))).toEqual({ ok: false, problem: "characters" });

    let caught = 0;
    for (let i = 0; i < 31; i++) {
      const swap = ALPHABET[(ALPHABET.indexOf(code[i]) + 7) % 32];
      const typo = code.slice(0, i) + swap + code.slice(i + 1);
      if (!(await parseRecoveryCode(typo)).ok) caught++;
    }
    expect(caught).toBeGreaterThanOrEqual(28); // 5-bit check: ~97% of single typos
  });
});

describe("unlock envelopes", () => {
  const vaultId = newId();

  it("password, recovery code and passkey each unwrap the same VMK, independently", async () => {
    const vmk = generateVmk();
    const code = await generateRecoveryCode();
    const prf = randomBytes(32);

    const pw = await createPasswordEnvelope(vmk, vaultId, "mango tree monsoon kettle");
    const rc = await createRecoveryEnvelope(vmk, vaultId, code);
    const pk = await createPrfEnvelope(vmk, vaultId, "cred-1", prf);

    const viaPw = await derivePasswordKeys("mango tree monsoon kettle", fromBase64(pw.envelope.salt), pw.envelope.kdf!);
    expect(equalBytes(await unwrapVmk(pw.envelope, viaPw.wrappingKey, vaultId), vmk)).toBe(true);
    expect(equalBytes(viaPw.authSecret, pw.authSecret)).toBe(true);

    const viaRc = await deriveRecoveryKeys(code, fromBase64(rc.envelope.salt));
    expect(equalBytes(await unwrapVmk(rc.envelope, viaRc.wrappingKey, vaultId), vmk)).toBe(true);

    const viaPk = await derivePrfWrappingKey(prf, fromBase64(pk.salt));
    expect(equalBytes(await unwrapVmk(pk, viaPk, vaultId), vmk)).toBe(true);

    // nothing in an envelope is the key, or the auth secret
    const flat = JSON.stringify([pw.envelope, rc.envelope, pk]);
    expect(flat.includes(toBase64(vmk))).toBe(false);
    expect(flat.includes(toBase64(pw.authSecret))).toBe(false);
  });

  it("a wrong password fails exactly like any other failure", async () => {
    const vmk = generateVmk();
    const pw = await createPasswordEnvelope(vmk, vaultId, "mango tree monsoon kettle");
    const wrong = await derivePasswordKeys("mango tree monsoon kettel", fromBase64(pw.envelope.salt), pw.envelope.kdf!);
    await expect(unwrapVmk(pw.envelope, wrong.wrappingKey, vaultId)).rejects.toBeInstanceOf(DecryptError);
  });

  it("envelopes don't transplant between vaults", async () => {
    const vmk = generateVmk();
    const prf = randomBytes(32);
    const pk = await createPrfEnvelope(vmk, vaultId, "cred-1", prf);
    const key = await derivePrfWrappingKey(prf, fromBase64(pk.salt));
    await expect(unwrapVmk(pk, key, newId())).rejects.toBeInstanceOf(DecryptError);
  });

  it("seals device labels and derives a write-auth key that isn't the VMK", async () => {
    const raw = generateVmk();
    const vmk = await importAesKey(raw);
    const env = await createPrfEnvelope(raw, vaultId, "cred-1", randomBytes(32));
    env.label = await sealLabel(vmk, env.id, "Mom's phone");
    expect(JSON.stringify(env).includes("Mom")).toBe(false);
    expect(await openLabel(vmk, env)).toBe("Mom's phone");

    const kw = await deriveWriteAuthKey(raw, vaultId);
    expect(equalBytes(kw, raw)).toBe(false);
    expect(equalBytes(kw, await deriveWriteAuthKey(raw, vaultId))).toBe(true);
  });
});
