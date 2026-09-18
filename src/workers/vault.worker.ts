/// <reference lib="webworker" />
import { RPC_METHODS, type RpcPush, type RpcRequest, type RpcResponse, isFnTicket } from "@/client/rpc";
import { VaultSession } from "@/client/session-core";

/**
 * The only place the vault key ever exists. The page talks to it by message;
 * keys never cross back. All crypto runs here too, so the UI thread never
 * stalls on a 20 MB scan.
 */
const post = (message: RpcResponse | RpcPush, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);

const session = new VaultSession((state) => post({ event: "state", state }));
const allowed = new Set<string>(RPC_METHODS);

/** Large results (a decrypted document on its way to the viewer) move rather than copy. */
function transferables(value: unknown, out: Transferable[] = [], depth = 0): Transferable[] {
  if (depth > 3 || !value || typeof value !== "object") return out;
  if (value instanceof Uint8Array) {
    if (value.byteLength > 65536 && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) out.push(value.buffer as ArrayBuffer);
    return out;
  }
  for (const v of Array.isArray(value) ? value : Object.values(value)) transferables(v, out, depth + 1);
  return out;
}

self.onmessage = async (e: MessageEvent<RpcRequest>) => {
  const { id, method, args } = e.data;
  try {
    if (!allowed.has(method)) throw new Error("unknown method");
    const fn = (session as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    const revived = args.map((a) => (isFnTicket(a) ? (...cb: unknown[]) => post({ callback: a.__fn, args: cb }) : a));
    const result = await fn.apply(session, revived);
    post({ id, ok: true, result }, transferables(result));
  } catch (err) {
    const x = err as { name?: string; message?: string; status?: number; code?: string; retryAfter?: number; detail?: string };
    post({ id, ok: false, error: { name: x?.name ?? "Error", message: x?.message ?? "failed", status: x?.status, code: x?.code, retryAfter: x?.retryAfter, detail: x?.detail } });
  }
};
