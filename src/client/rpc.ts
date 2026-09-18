import type { VaultSession, VaultState } from "./session-core";

/** The methods the page may call on the worker. Anything not listed doesn't exist as far as the page is concerned. */
export const RPC_METHODS = [
  "init", "loadConfig",
  "beginSetup", "checkRecoveryGroups", "completeSetup", "selfTest",
  "unlockWithPassword", "unlockWithRecoveryCode", "passkeyOptions", "unlockWithPasskey", "resumeSession", "lock",
  "findDuplicate", "addDocuments", "openDocument", "updateMeta", "trash", "restore", "deletePermanently",
  "saveProfile", "removeProfile", "saveCategory", "setSetting", "syncNow", "refresh",
  "findOrphans", "recoverOrphans", "discardOrphans", "rebuild",
  "setPrefs", "setPinned", "forgetDevice",
  "enrolOptions", "enrolPasskey", "devices", "removeDevice", "setDeviceRole", "changePassword", "signOutEverywhere",
  "beginNewRecoveryCode", "commitNewRecoveryCode",
  "exportArchive", "backupToFolder", "inspectBackup", "restoreBackup",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

type Fn = (...args: never[]) => unknown;
export type VaultRpc = {
  [K in RpcMethod & keyof VaultSession]: VaultSession[K] extends Fn
    ? (...args: Parameters<VaultSession[K]>) => Promise<Awaited<ReturnType<VaultSession[K]>>>
    : never;
};

export interface RpcRequest { id: number; method: string; args: unknown[] }
export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string; status?: number; code?: string; retryAfter?: number; detail?: string } };
export type RpcPush = { event: "state"; state: VaultState } | { callback: number; args: unknown[] };

/** How a function argument crosses postMessage: as a ticket the worker can call back on. */
export interface FnTicket { __fn: number }
export const isFnTicket = (v: unknown): v is FnTicket => !!v && typeof v === "object" && "__fn" in (v as object);

export class RpcError extends Error {
  status?: number;
  code?: string;
  retryAfter?: number;
  detail?: string;
  constructor(e: Extract<RpcResponse, { ok: false }>["error"]) {
    super(e.message);
    this.name = e.name;
    Object.assign(this, { status: e.status, code: e.code, retryAfter: e.retryAfter, detail: e.detail });
  }
}
