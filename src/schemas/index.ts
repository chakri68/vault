import { z } from "zod";
import { DocFactsSchema, DocMetaSchema, FieldVersionsSchema } from "./file";

const isoDate = z.string().min(1).max(40);

export const ProfileSchema = z.object({
  id: z.string().min(1).max(64),
  displayName: z.string().min(1).max(80),
  avatar: z.object({ type: z.enum(["emoji", "initials"]), value: z.string().max(16) }).optional(),
  /** category key whose tint the avatar borrows; assigned once */
  tint: z.string().max(32).optional(),
  preferences: z
    .object({
      defaultView: z.enum(["grid", "list"]).optional(),
      defaultSort: z.enum(["recent", "name", "expiry"]).optional(),
    })
    .optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deletedAt: isoDate.optional(),
});
export type VaultProfile = z.infer<typeof ProfileSchema>;

export const CategorySchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  createdAt: isoDate,
  updatedAt: isoDate,
  deletedAt: isoDate.optional(),
});
export type Category = z.infer<typeof CategorySchema>;

export const IndexEntrySchema = DocFactsSchema.extend(DocMetaSchema.shape).extend({
  objectPath: z.string(),
  encryptedSize: z.number().int().nonnegative(),
  partCount: z.number().int().min(1).max(64),
  state: z.enum(["active", "trashed"]),
  trashedAt: isoDate.optional(),
  updatedAt: isoDate,
  fieldVersions: FieldVersionsSchema,
});
export type IndexEntry = z.infer<typeof IndexEntrySchema>;

export const TombstoneSchema = z.object({
  deletedAt: isoDate,
  purgeAfter: isoDate,
  shredded: z.boolean(),
});
export type Tombstone = z.infer<typeof TombstoneSchema>;

/** Vault-wide settings, each an LWW register so two devices can't clobber each other. */
export const SettingSchema = z.object({ value: z.unknown(), v: z.number().nonnegative() });
export type Setting = z.infer<typeof SettingSchema>;

export const VaultIndexSchema = z.object({
  version: z.literal(1),
  updatedAt: isoDate,
  entries: z.record(z.string(), IndexEntrySchema),
  tombstones: z.record(z.string(), TombstoneSchema),
  profiles: z.array(ProfileSchema),
  categories: z.array(CategorySchema),
  settings: z.record(z.string(), SettingSchema).default({}),
});
export type VaultIndex = z.infer<typeof VaultIndexSchema>;
