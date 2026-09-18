/**
 * Detection is tested against synthetic files built byte by byte here.
 *
 * What this does NOT test: the canvas re-encode that does the actual removal
 * (image.ts) — there's no canvas in node. It is covered at one remove:
 * `containsMetadataMarkers` is the check applied to a re-encoder's output, and
 * it's exercised on "clean" files shaped like what a canvas emits (JFIF-only
 * JPEG, IHDR/IDAT/IEND PNG, bare VP8 WebP) and on the dirty originals.
 * The end-to-end strip is verified in a real browser.
 */
import { describe, expect, it } from "vitest";
import {
  containsMetadataMarkers, describeHiddenDetails, detectHiddenDetails, readXmp, sniffImageFormat,
} from "./metadata";

const te = new TextEncoder();
const cat = (...parts: Array<Uint8Array | number[]>) => {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
};
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

// ───────────── builders ─────────────

interface TiffSpec { ifd0?: number[]; exif?: number[]; gps?: number[]; ifd1?: number[]; bigEndian?: boolean }

/** A TIFF block with the given tags in each directory. Values are dummies; the parser only cares which tags exist. */
function tiff({ ifd0 = [], exif, gps, ifd1, bigEndian = false }: TiffSpec): Uint8Array {
  const w16 = (n: number) => (bigEndian ? u16be(n) : [n & 0xff, (n >> 8) & 0xff]);
  const w32 = (n: number) => (bigEndian ? u32be(n) : u32le(n));
  const size = (tags: number[]) => 2 + tags.length * 12 + 4;

  const tags0 = [...ifd0, ...(exif ? [0x8769] : []), ...(gps ? [0x8825] : [])];
  const at0 = 8;
  const atExif = at0 + size(tags0);
  const atGps = atExif + (exif ? size(exif) : 0);
  const at1 = atGps + (gps ? size(gps) : 0);

  const dir = (tags: number[], next: number, pointers: Record<number, number> = {}) =>
    cat(w16(tags.length), ...tags.map((t) => cat(w16(t), w16(4), w32(1), w32(pointers[t] ?? 0))), w32(next));

  return cat(
    bigEndian ? [0x4d, 0x4d] : [0x49, 0x49], w16(42), w32(at0),
    dir(tags0, ifd1 ? at1 : 0, { 0x8769: atExif, 0x8825: atGps }),
    exif ? dir(exif, 0) : [],
    gps ? dir(gps, 0) : [],
    ifd1 ? dir(ifd1, 0) : [],
  );
}

const segment = (marker: number, payload: Uint8Array) => cat([0xff, marker], u16be(payload.length + 2), payload);
const JFIF = segment(0xe0, cat(te.encode("JFIF\0"), [1, 1, 0, 0, 1, 0, 1, 0, 0]));
const SCAN = cat([0xff, 0xda], u16be(2), [0x11, 0x22, 0x33], [0xff, 0xd9]);

const jpeg = (...segments: Uint8Array[]) => cat([0xff, 0xd8], JFIF, ...segments, SCAN);
const exifSegment = (spec: TiffSpec) => segment(0xe1, cat(te.encode("Exif\0\0"), tiff(spec)));
const xmpSegment = (xml: string) => segment(0xe1, cat(te.encode("http://ns.adobe.com/xap/1.0/\0"), te.encode(xml)));

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const chunk = (type: string, data: Uint8Array | number[] = []) =>
  cat(u32be(data.length), te.encode(type), data, [0, 0, 0, 0]); // CRC isn't checked by the detector
const png = (...chunks: Uint8Array[]) =>
  cat(PNG_SIG, chunk("IHDR", new Uint8Array(13)), ...chunks, chunk("IDAT", [1, 2, 3]), chunk("IEND"));

const riffChunk = (type: string, data: Uint8Array) => cat(te.encode(type), u32le(data.length), data, data.length & 1 ? [0] : []);
const webp = (...chunks: Uint8Array[]) => {
  const body = cat(te.encode("WEBP"), ...chunks, riffChunk("VP8 ", new Uint8Array([9, 9, 9, 9])));
  return cat(te.encode("RIFF"), u32le(body.length), body);
};

const XMP_GPS = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description exif:GPSLatitude="17,23.1N" tiff:Model="Pixel 9" xmp:CreateDate="2026-09-18T17:29:14" xmp:CreatorTool="Camera"/></x:xmpmeta>`;

// ───────────── tests ─────────────

describe("sniffImageFormat", () => {
  it("goes by the bytes, not the file name", () => {
    expect(sniffImageFormat(jpeg())).toBe("jpeg");
    expect(sniffImageFormat(png())).toBe("png");
    expect(sniffImageFormat(webp())).toBe("webp");
    expect(sniffImageFormat(cat(u32be(24), te.encode("ftypheic"), new Uint8Array(12)))).toBe("heic");
    expect(sniffImageFormat(te.encode("%PDF-1.7"))).toBe("unknown");
    expect(sniffImageFormat(new Uint8Array(0))).toBe("unknown");
  });
});

describe("JPEG", () => {
  it("a clean JPEG has nothing to report", () => {
    const d = detectHiddenDetails(jpeg());
    expect(d.any).toBe(false);
    expect(containsMetadataMarkers(jpeg())).toBe(false);
  });

  it("finds each kind of detail, and only the kinds that are there", () => {
    const camera = detectHiddenDetails(jpeg(exifSegment({ ifd0: [0x010f, 0x0110] }))).details;
    expect(camera).toEqual({ location: false, camera: true, timestamp: false, software: false, thumbnail: false });

    const gps = detectHiddenDetails(jpeg(exifSegment({ gps: [0x0000, 0x0001, 0x0002, 0x0003, 0x0004] }))).details;
    expect(gps.location).toBe(true);
    expect(gps.camera).toBe(false);

    const when = detectHiddenDetails(jpeg(exifSegment({ exif: [0x9003] }))).details;
    expect(when).toMatchObject({ timestamp: true, location: false });

    const everything = detectHiddenDetails(jpeg(exifSegment({
      ifd0: [0x010f, 0x0110, 0x0131, 0x0132], exif: [0x9003, 0xa434], gps: [0x0002, 0x0004], ifd1: [0x0201, 0x0202],
    })));
    expect(everything.details).toEqual({ location: true, camera: true, timestamp: true, software: true, thumbnail: true });
    expect(describeHiddenDetails(everything.details)).toEqual([
      "Location where it was taken", "Camera model", "Date and time", "App it was made with", "A small hidden copy of the picture",
    ]);
  });

  it("a GPS directory holding only its version tag isn't a location", () => {
    expect(detectHiddenDetails(jpeg(exifSegment({ gps: [0x0000] }))).details.location).toBe(false);
  });

  it("reads big-endian Exif too", () => {
    expect(detectHiddenDetails(jpeg(exifSegment({ ifd0: [0x0110], gps: [0x0002], bigEndian: true }))).details)
      .toMatchObject({ camera: true, location: true });
  });

  it("finds details that are only in XMP", () => {
    const d = detectHiddenDetails(jpeg(xmpSegment(XMP_GPS))).details;
    expect(d).toMatchObject({ location: true, camera: true, timestamp: true, software: true });
  });

  it("doesn't mistake picture data for metadata", () => {
    // the bytes of an Exif block, but after start-of-scan: that's image data
    const fake = cat([0xff, 0xd8], JFIF, [0xff, 0xda], u16be(2), exifSegment({ gps: [0x0002] }), [0xff, 0xd9]);
    expect(detectHiddenDetails(fake).any).toBe(false);
  });

  it("survives truncated and hostile input", () => {
    const whole = jpeg(exifSegment({ ifd0: [0x010f], exif: [0x9003], gps: [0x0002] }));
    for (let cut = 0; cut < whole.length; cut += 3) expect(() => detectHiddenDetails(whole.subarray(0, cut))).not.toThrow();
    // an IFD that points at itself
    const loop = tiff({ ifd0: [0x8769] });
    new DataView(loop.buffer).setUint32(8 + 2 + 8, 8, true);
    expect(() => detectHiddenDetails(jpeg(segment(0xe1, cat(te.encode("Exif\0\0"), loop))))).not.toThrow();
  });
});

describe("PNG", () => {
  it("clean", () => {
    expect(detectHiddenDetails(png()).any).toBe(false);
    expect(containsMetadataMarkers(png())).toBe(false);
  });

  it("eXIf, XMP in iTXt, tIME and text keywords", () => {
    expect(detectHiddenDetails(png(chunk("eXIf", tiff({ ifd0: [0x0110], gps: [0x0002] })))).details)
      .toMatchObject({ camera: true, location: true });
    expect(detectHiddenDetails(png(chunk("iTXt", te.encode(`XML:com.adobe.xmp\0\0\0\0\0${XMP_GPS}`)))).details.location).toBe(true);
    expect(detectHiddenDetails(png(chunk("tIME", [7, 234, 9, 18, 17, 29, 14]))).details.timestamp).toBe(true);
    expect(detectHiddenDetails(png(chunk("tEXt", te.encode("Software\0Screenshot")))).details.software).toBe(true);
    expect(detectHiddenDetails(png(chunk("tEXt", te.encode("Comment\0hello")))).any).toBe(false);
  });
});

describe("WebP", () => {
  it("clean", () => {
    expect(detectHiddenDetails(webp()).any).toBe(false);
    expect(containsMetadataMarkers(webp())).toBe(false);
  });

  it("EXIF (with and without the JPEG-style prefix) and XMP chunks, including odd-length ones", () => {
    const t = tiff({ ifd0: [0x010f], gps: [0x0004] });
    expect(detectHiddenDetails(webp(riffChunk("EXIF", t))).details).toMatchObject({ camera: true, location: true });
    expect(detectHiddenDetails(webp(riffChunk("EXIF", cat(te.encode("Exif\0\0"), t)))).details.location).toBe(true);
    const odd = te.encode(`${XMP_GPS} `.slice(0, XMP_GPS.length | 1));
    expect(detectHiddenDetails(webp(riffChunk("XMP ", odd), riffChunk("EXIF", t))).details).toMatchObject({ software: true, location: true });
  });
});

describe("HEIC", () => {
  it("finds Exif by scanning, since the box structure isn't parsed", () => {
    const heic = cat(u32be(24), te.encode("ftypheic"), new Uint8Array(12), new Uint8Array(40), [0, 0, 0, 6], te.encode("Exif\0\0"), tiff({ ifd0: [0x0110], gps: [0x0002] }));
    expect(detectHiddenDetails(heic)).toMatchObject({ format: "heic", any: true, details: { camera: true, location: true } });
  });
});

describe("readXmp", () => {
  it("ignores packets with nothing personal in them", () => {
    expect(Object.values(readXmp(`<x:xmpmeta><rdf:Description dc:format="image/jpeg"/></x:xmpmeta>`)).some(Boolean)).toBe(false);
  });
});

describe("containsMetadataMarkers: the after-the-re-encode check", () => {
  it("flags every carrier the spec names (Exif, XMP, iCCP), whatever the detector thinks of the contents", () => {
    expect(containsMetadataMarkers(jpeg(exifSegment({})))).toBe(true);
    expect(containsMetadataMarkers(jpeg(xmpSegment("<x:xmpmeta/>")))).toBe(true);
    expect(containsMetadataMarkers(jpeg(segment(0xe2, te.encode("ICC_PROFILE\0\x01\x01"))))).toBe(true);
    expect(containsMetadataMarkers(jpeg(segment(0xed, te.encode("Photoshop 3.0\0"))))).toBe(true);
    expect(containsMetadataMarkers(png(chunk("iCCP", te.encode("sRGB\0\0"))))).toBe(true);
    expect(containsMetadataMarkers(png(chunk("eXIf", tiff({}))))).toBe(true);
    expect(containsMetadataMarkers(webp(riffChunk("ICCP", new Uint8Array(4))))).toBe(true);
    expect(containsMetadataMarkers(webp(riffChunk("XMP ", te.encode("<x:xmpmeta/>"))))).toBe(true);
  });

  it("passes files shaped like a canvas encoder's output", () => {
    for (const clean of [jpeg(), png(), webp()]) {
      expect(containsMetadataMarkers(clean)).toBe(false);
      expect(detectHiddenDetails(clean).any).toBe(false);
    }
  });
});
