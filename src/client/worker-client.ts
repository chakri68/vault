import { RPC_METHODS, RpcError, type RpcPush, type RpcResponse, type VaultRpc } from "./rpc";
import type { VaultState } from "./session-core";

/** Page-side handle on the vault worker: typed calls out, state pushes in. */
export function createVaultWorker(onState: (state: VaultState) => void): { rpc: VaultRpc; terminate: () => void } {
  const worker = new Worker(new URL("../workers/vault.worker.ts", import.meta.url), { type: "module", name: "vault" });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; callbacks: number[] }>();
  const callbacks = new Map<number, (...args: unknown[]) => void>();
  let seq = 0;

  worker.onmessage = (e: MessageEvent<RpcResponse | RpcPush>) => {
    const m = e.data;
    if ("event" in m) return onState(m.state);
    if ("callback" in m) return callbacks.get(m.callback)?.(...m.args);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    for (const c of p.callbacks) callbacks.delete(c);
    if (m.ok) p.resolve(m.result);
    else p.reject(new RpcError(m.error));
  };

  const call = (method: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++seq;
      const mine: number[] = [];
      const wire = args.map((a) => {
        if (typeof a !== "function") return a;
        const ticket = ++seq;
        callbacks.set(ticket, a as (...x: unknown[]) => void);
        mine.push(ticket);
        return { __fn: ticket };
      });
      pending.set(id, { resolve, reject, callbacks: mine });
      worker.postMessage({ id, method, args: wire });
    });

  const rpc = Object.fromEntries(RPC_METHODS.map((m) => [m, (...args: unknown[]) => call(m, args)])) as unknown as VaultRpc;
  return { rpc, terminate: () => worker.terminate() };
}
