"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useVault } from "@/client/vault-provider";
import { Banner, Button, useToast } from "@/components/ui";
import { AuthHeading, AuthScreen, InlineError, WorkingLine } from "./auth-screen";
import { NewPasswordFields, useNewPassword } from "./new-password-fields";

// Whether this unlock's prompt has been dealt with. Module-level: it has to
// survive navigation inside the app, and reset when the vault locks.
let settled = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function setSettled(value: boolean) {
  if (settled === value) return;
  settled = value;
  for (const l of listeners) l();
}

/**
 * Someone who got in with the recovery code has, by definition, lost the family
 * password. Before anything else, they set a new one — otherwise the next
 * lock-out needs the paper again.
 *
 * Mount it anywhere inside the unlocked app. It draws over everything while
 * `state.via === "recovery"` and the new password isn't set, and is nothing
 * the rest of the time.
 */
export function NewPasswordPrompt() {
  const { state, rpc, online, lock } = useVault();
  const { toast } = useToast();
  const done = useSyncExternalStore(subscribe, () => settled, () => true);
  const form = useNewPassword();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const due = state.phase === "unlocked" && state.via === "recovery";

  // a fresh recovery unlock asks again
  useEffect(() => {
    if (!due) setSettled(false);
  }, [due]);

  if (!due || done) return null;

  const save = async () => {
    if (busy) return;
    setError(null);
    const password = await form.validate();
    if (!password) return;
    setBusy(true);
    try {
      await rpc.changePassword(password);
      setSettled(true);
      toast({ message: "Family password changed" });
    } catch (e) {
      const offlineNow = (e as Error)?.name === "TypeError";
      setError(
        offlineNow
          ? "Couldn't reach the vault to save the new password. Connect to the internet, then try again."
          : "The new password wasn't saved. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  };

  // Offline, the change can't be saved. The documents they came for shouldn't wait on that (§2.3).
  const canDefer = !online || state.needsSession;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-canvas">
      <AuthScreen
        onSubmit={() => void save()}
        actions={
          <>
            {error && <InlineError>{error}</InlineError>}
            <Button type="submit" size="lg" loading={busy} loadingLabel="Saving…">Save new password</Button>
            <WorkingLine active={busy} label="Saving the new password" />
            {canDefer ? (
              <Button variant="text" className="self-center" onClick={() => setSettled(true)}>Do this later</Button>
            ) : (
              <Button variant="text" className="self-center" onClick={() => void lock()}>Lock instead</Button>
            )}
          </>
        }
      >
        <AuthHeading title="Choose a new family password">
          <p>You got in with the recovery code, so the old password is lost. Pick a new one now, and tell the family.</p>
        </AuthHeading>
        {canDefer && (
          <Banner tone="info" title="You're offline">
            The new password can&rsquo;t be saved until this phone is back online. Your documents on this phone still open.
          </Banner>
        )}
        <NewPasswordFields form={form} disabled={busy} />
        <p className="max-w-[65ch] text-callout text-ink-3">
          The recovery code still works, and phones that open with a fingerprint keep working. Keep the code where it was.
        </p>
      </AuthScreen>
    </div>
  );
}
