import { api, json } from "@/server/api";
import { LIMITS } from "@/server/rate-limit";

// A write here is a store round trip — on GitHub, six of them in a row. Say how long that may take rather than inherit a platform default.
export const maxDuration = 60;

/** Ids, roles and dates. Device names are in vault.json, sealed, where the server can't read them. */
export const GET = api({ auth: "session", limit: LIMITS.meta }, async ({ registry, session }) =>
  json({
    current: session!.cred ?? null,
    credentials: registry!.credentials.map((c) => ({ id: c.id, role: c.role, createdAt: c.createdAt })),
  }));
