import { api, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";

/** Ids, roles and dates. Device names are in vault.json, sealed, where the server can't read them. */
export const GET = api({ auth: "session", limit: LIMITS.meta }, async ({ registry, session }) =>
  json({
    current: session!.cred ?? null,
    credentials: registry!.credentials.map((c) => ({ id: c.id, role: c.role, createdAt: c.createdAt })),
  }));
