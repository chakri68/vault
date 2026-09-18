/**
 * §15. What a photo says about the family besides what's in the frame.
 *
 * Pure functions over bytes, no dependencies, nothing sent anywhere. This only
 * *detects*; removal is done by re-encoding through a canvas (image.ts), which
 * drops every ancillary segment by construction rather than by trusting a
 * parser to have found them all. `containsMetadataMarkers` is the check that
 * the re-encode really did.
 */

export type ImageFormat = "jpeg" | "png" | "webp" | "heic" | "unknown";

export interface HiddenDetails {
  /** GPS coordinates: frequently the family's home */
  location: boolean;
  /** camera or phone make and model, lens */
  camera: boolean;
  /** when it was taken */
  timestamp: boolean;
  /** the app that made or edited it */
  software: boolean;
  /** a small embedded copy of the picture, which can outlive a crop */
  thumbnail: boolean;
}

export interface Detection {
  format: ImageFormat;
  details: HiddenDetails;
  /** true when any of the details is present */
  any: boolean;
}

const NONE: HiddenDetails = { location: false, camera: false, timestamp: false, software: false, thumbnail: false };

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, Math.min(start + length, bytes.length)));

function startsWith(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function indexOf(bytes: Uint8Array, text: string, from = 0, to = bytes.length): number {
  const first = text.charCodeAt(0);
  const last = Math.min(to, bytes.length) - text.length;
  for (let i = from; i <= last; i++) if (bytes[i] === first && startsWith(bytes, i, text)) return i;
  return -1;
}

export function sniffImageFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && startsWith(bytes, 1, "PNG\r\n\x1a\n")) return "png";
  if (bytes.length >= 12 && startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP")) return "webp";
  if (bytes.length >= 12 && startsWith(bytes, 4, "ftyp")) {
    const brand = ascii(bytes, 8, 4);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif"].includes(brand)) return "heic";
  }
  return "unknown";
}

// ───────────────────────── TIFF / Exif ─────────────────────────

const TAG = {
  make: 0x010f, model: 0x0110, software: 0x0131, dateTime: 0x0132,
  exifIfd: 0x8769, gpsIfd: 0x8825,
  dateTimeOriginal: 0x9003, dateTimeDigitized: 0x9004, makerNote: 0x927c,
  lensMake: 0xa433, lensModel: 0xa434, bodySerial: 0xa431,
  thumbnailOffset: 0x0201,
  gpsVersion: 0x0000,
} as const;

/** Reads enough of a TIFF structure to know which kinds of detail it carries. Never throws. */
export function readTiff(bytes: Uint8Array, start: number, end = bytes.length): HiddenDetails {
  const out = { ...NONE };
  if (start + 8 > end) return out;
  const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  const big = bytes[start] === 0x4d && bytes[start + 1] === 0x4d;
  if (!little && !big) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  if (u16(2) !== 42) return out;

  const seen = new Set<number>();
  const walk = (offset: number, kind: "ifd0" | "exif" | "gps" | "ifd1"): number => {
    if (offset <= 0 || offset + 2 > view.byteLength || seen.has(offset)) return 0;
    seen.add(offset);
    const count = u16(offset);
    if (offset + 2 + count * 12 > view.byteLength) return 0;
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      const tag = u16(entry);
      const value = u32(entry + 8);
      if (kind === "gps") {
        if (tag !== TAG.gpsVersion) out.location = true;
        continue;
      }
      if (kind === "ifd1") {
        if (tag === TAG.thumbnailOffset) out.thumbnail = true;
        continue;
      }
      switch (tag) {
        case TAG.make: case TAG.model: case TAG.lensMake: case TAG.lensModel: case TAG.bodySerial: case TAG.makerNote:
          out.camera = true; break;
        case TAG.software: out.software = true; break;
        case TAG.dateTime: case TAG.dateTimeOriginal: case TAG.dateTimeDigitized:
          out.timestamp = true; break;
        case TAG.exifIfd: walk(value, "exif"); break;
        case TAG.gpsIfd: walk(value, "gps"); break;
      }
    }
    const next = offset + 2 + count * 12;
    return next + 4 <= view.byteLength ? u32(next) : 0;
  };

  try {
    const ifd1 = walk(u32(4), "ifd0");
    if (ifd1) walk(ifd1, "ifd1");
  } catch {
    // a malformed structure tells us nothing more; what was found so far stands
  }
  return out;
}

/** XMP is text. Look for the properties that matter rather than parsing RDF. */
export function readXmp(text: string): HiddenDetails {
  return {
    location: /exif:GPS|GPSLatitude|GPSLongitude|Iptc4xmpCore:Location|photoshop:City/i.test(text),
    camera: /tiff:Make|tiff:Model|aux:Lens|exifEX:LensModel|aux:SerialNumber/i.test(text),
    timestamp: /xmp:CreateDate|xmp:ModifyDate|photoshop:DateCreated|exif:DateTimeOriginal/i.test(text),
    software: /xmp:CreatorTool|tiff:Software/i.test(text),
    thumbnail: /xmp:Thumbnails|xmpGImg:image/i.test(text),
  };
}

function merge(a: HiddenDetails, b: HiddenDetails): HiddenDetails {
  return {
    location: a.location || b.location, camera: a.camera || b.camera, timestamp: a.timestamp || b.timestamp,
    software: a.software || b.software, thumbnail: a.thumbnail || b.thumbnail,
  };
}

const latin1 = (bytes: Uint8Array, start: number, end: number) => {
  let out = "";
  for (let i = start; i < Math.min(end, bytes.length); i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, end, bytes.length)));
  }
  return out;
};

// ───────────────────────── containers ─────────────────────────

const XMP_NS = "http://ns.adobe.com/xap/1.0/\0";

function detectJpeg(bytes: Uint8Array): HiddenDetails {
  let out = { ...NONE };
  let o = 2;
  while (o + 4 <= bytes.length && bytes[o] === 0xff) {
    const marker = bytes[o + 1];
    if (marker === 0xda || marker === 0xd9) break; // start of scan: the picture itself
    if (marker === 0xff) { o += 1; continue; } // fill byte
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue; }
    const length = (bytes[o + 2] << 8) | bytes[o + 3];
    if (length < 2) break;
    const start = o + 4;
    const end = Math.min(o + 2 + length, bytes.length);
    if (marker === 0xe1) {
      if (startsWith(bytes, start, "Exif\0\0")) out = merge(out, readTiff(bytes, start + 6, end));
      else if (startsWith(bytes, start, XMP_NS)) out = merge(out, readXmp(latin1(bytes, start + XMP_NS.length, end)));
    }
    o = end;
  }
  return out;
}

function detectPng(bytes: Uint8Array): HiddenDetails {
  let out = { ...NONE };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  while (o + 12 <= bytes.length) {
    const length = view.getUint32(o);
    const type = ascii(bytes, o + 4, 4);
    const start = o + 8;
    const end = Math.min(start + length, bytes.length);
    if (type === "eXIf") out = merge(out, readTiff(bytes, start, end));
    else if (type === "tIME") out.timestamp = true;
    else if (type === "iTXt" || type === "tEXt" || type === "zTXt") {
      const text = latin1(bytes, start, end);
      const keyword = text.slice(0, text.indexOf("\0")).toLowerCase();
      if (keyword === "xml:com.adobe.xmp") out = merge(out, readXmp(text));
      else if (keyword === "software") out.software = true;
      else if (keyword === "creation time") out.timestamp = true;
      else if (keyword.startsWith("raw profile type exif")) out = merge(out, { ...NONE, camera: true, timestamp: true });
    } else if (type === "IEND") break;
    o = end + 4;
  }
  return out;
}

function detectWebp(bytes: Uint8Array): HiddenDetails {
  let out = { ...NONE };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  while (o + 8 <= bytes.length) {
    const type = ascii(bytes, o, 4);
    const length = view.getUint32(o + 4, true);
    const start = o + 8;
    const end = Math.min(start + length, bytes.length);
    if (type === "EXIF") {
      // some encoders keep the JPEG-style "Exif\0\0" prefix in front of the TIFF header
      const tiff = startsWith(bytes, start, "Exif\0\0") ? start + 6 : start;
      out = merge(out, readTiff(bytes, tiff, end));
    } else if (type === "XMP ") out = merge(out, readXmp(latin1(bytes, start, end)));
    o = end + (length & 1); // chunks are padded to even length
  }
  return out;
}

/** HEIC and friends bury Exif in an item box. Finding the TIFF header after the Exif marker is enough to read it. */
function detectByScan(bytes: Uint8Array): HiddenDetails {
  let out = { ...NONE };
  const limit = Math.min(bytes.length, 4 * 1024 * 1024);
  let at = indexOf(bytes, "Exif\0\0", 0, limit);
  while (at !== -1) {
    out = merge(out, readTiff(bytes, at + 6));
    at = indexOf(bytes, "Exif\0\0", at + 6, limit);
  }
  const xmp = indexOf(bytes, "<x:xmpmeta", 0, limit);
  if (xmp !== -1) out = merge(out, readXmp(latin1(bytes, xmp, Math.min(xmp + 256 * 1024, limit))));
  return out;
}

export function detectHiddenDetails(bytes: Uint8Array): Detection {
  const format = sniffImageFormat(bytes);
  let details = { ...NONE };
  try {
    if (format === "jpeg") details = detectJpeg(bytes);
    else if (format === "png") details = detectPng(bytes);
    else if (format === "webp") details = detectWebp(bytes);
    else if (format === "heic") details = detectByScan(bytes);
  } catch {
    // unreadable isn't the same as clean, but there's nothing specific to report
  }
  return { format, details, any: Object.values(details).some(Boolean) };
}

/** In plain words, never "EXIF" (§15). */
export function describeHiddenDetails(details: HiddenDetails): string[] {
  const out: string[] = [];
  if (details.location) out.push("Location where it was taken");
  if (details.camera) out.push("Camera model");
  if (details.timestamp) out.push("Date and time");
  if (details.software) out.push("App it was made with");
  if (details.thumbnail) out.push("A small hidden copy of the picture");
  return out;
}

/**
 * A blunt byte-level check, independent of the parsers above: does anything in
 * here look like an Exif block, an XMP packet or an embedded colour profile?
 * Used to verify that a re-encoded image really came out clean.
 */
export function containsMetadataMarkers(bytes: Uint8Array): boolean {
  const format = sniffImageFormat(bytes);
  if (format === "png") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 8;
    while (o + 12 <= bytes.length) {
      const type = ascii(bytes, o + 4, 4);
      if (["eXIf", "iTXt", "tEXt", "zTXt", "iCCP", "tIME"].includes(type)) return true;
      if (type === "IEND") break;
      o += 12 + view.getUint32(o);
    }
    return false;
  }
  if (format === "webp") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 12;
    while (o + 8 <= bytes.length) {
      const type = ascii(bytes, o, 4);
      if (type === "EXIF" || type === "XMP " || type === "ICCP") return true;
      const length = view.getUint32(o + 4, true);
      o += 8 + length + (length & 1);
    }
    return false;
  }
  if (format === "jpeg") {
    let o = 2;
    while (o + 4 <= bytes.length && bytes[o] === 0xff) {
      const marker = bytes[o + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xff) { o += 1; continue; }
      const length = (bytes[o + 2] << 8) | bytes[o + 3];
      if (length < 2) break;
      // APP1 (Exif, XMP), APP2 (ICC profile), APP13 (Photoshop / IPTC), COM
      if (marker === 0xe1 || marker === 0xe2 || marker === 0xed || marker === 0xfe) return true;
      o += 2 + length;
    }
    return false;
  }
  return indexOf(bytes, "Exif\0\0") !== -1 || indexOf(bytes, "<x:xmpmeta") !== -1 || indexOf(bytes, "ICC_PROFILE") !== -1;
}
