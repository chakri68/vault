import { z } from "zod";

const isoDate = z.string().min(1).max(40);
const id = z.string().min(1).max(64);

export const DocumentDetailsSchema = z.object({
  issueDate: isoDate.optional(),
  expiryDate: isoDate.optional(),
  issuer: z.string().max(200).optional(),
  referenceNumber: z.string().max(200).optional(),
});
export type DocumentDetails = z.infer<typeof DocumentDetailsSchema>;

/**
 * Everything a family member can edit after upload. Lives in the index and in
 * the object's sidecar (`objects/<id>.meta.vault`); the content object itself
 * is immutable, so a rename never re-uploads a scan.
 */
export const DocMetaSchema = z.object({
  name: z.string().min(1).max(200),
  ownerProfileIds: z.array(id).max(32),
  category: z.string().max(64).optional(),
  tags: z.array(z.string().min(1).max(64)).max(64),
  note: z.string().max(4000).optional(),
  document: DocumentDetailsSchema.optional(),
  temporary: z.object({ expiresAt: isoDate }).optional(),
  /** months before expiry to remind at (§22.1) */
  reminders: z.array(z.number().int().min(0).max(24)).max(8).optional(),
});
export type DocMeta = z.infer<typeof DocMetaSchema>;

/** Facts about the stored bytes. Fixed at upload, never edited. */
export const DocFactsSchema = z.object({
  id,
  extension: z.string().max(16),
  mimeType: z.string().max(128),
  plaintextSize: z.number().int().nonnegative(),
  checksum: z.string().length(64), // SHA-256 of the plaintext, hex
  createdByProfileId: id.optional(),
  createdAt: isoDate,
});
export type DocFacts = z.infer<typeof DocFactsSchema>;

/**
 * Headers and sidecars reference people and categories by id. The names live in
 * the index — so a rebuild from headers alone would bring back "who" as a bare
 * uuid. These hints are a snapshot of the names at write time, for Repair only.
 */
export const HintsSchema = z.object({
  people: z
    .array(z.object({
      id,
      displayName: z.string().max(80),
      tint: z.string().max(32).optional(),
      avatar: z.object({ type: z.enum(["emoji", "initials"]), value: z.string().max(16) }).optional(),
    }))
    .max(32)
    .optional(),
  categoryName: z.string().max(64).optional(),
});
export type Hints = z.infer<typeof HintsSchema>;

/** §8.2: the header sealed inside every object, as it was at upload. */
export const ObjectHeaderSchema = DocFactsSchema.extend(DocMetaSchema.shape).extend({
  version: z.literal(1),
  updatedAt: isoDate,
  hints: HintsSchema.optional(),
});
export type ObjectHeader = z.infer<typeof ObjectHeaderSchema>;

export const FieldVersionsSchema = z.record(z.string(), z.number().nonnegative());
export type FieldVersions = Record<string, number>;

/** The sidecar: current metadata plus enough facts to rebuild an index entry alone. */
export const SidecarSchema = z.object({
  version: z.literal(1),
  facts: DocFactsSchema,
  meta: DocMetaSchema,
  fieldVersions: FieldVersionsSchema,
  encryptedSize: z.number().int().nonnegative(),
  partCount: z.number().int().min(1).max(64),
  updatedAt: isoDate,
  hints: HintsSchema.optional(),
});
export type Sidecar = z.infer<typeof SidecarSchema>;
