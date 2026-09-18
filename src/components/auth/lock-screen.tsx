"use client";

import { Fingerprint, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { PasskeyCancelled, PrfUnsupported, getAssertion, passkeysAvailable, unlockWords } from "@/client/passkey";
import type { UnlockResult } from "@/client/session-core";
import { useVault } from "@/client/vault-provider";
import { AppMark, Banner, Button, Field, Icon, PasswordField } from "@/components/ui";
import { AuthScreen, InlineError, WorkingLine, waitWords } from "./auth-screen";
import { CantGetIn } from "./cant-get-in";
import { RecoveryEntry } from "./recovery-entry";

type View = "lock" | "help" | "recovery";
type Notice = "use-password" | "first-time" | "key-changed" | null;

// One answer for every kind of wrong: no hint about which part was off (§40.6).
const WRONG = "That password didn't work. Check caps lock and try again.";

/**
 * §11.1. Says what the app is and nothing about what's in it: no counts, no
 * names, no avatars, no reminders. Actions sit in thumb reach.
 */
export function LockScreen() {
  const { state, rpc } = useVault();
  const [view, setView] = useState<View>("lock");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"passkey" | "password" | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [platformReady, setPlatformReady] = useState(false);
  const [words, setWords] = useState(() => unlockWords("other"));

  useEffect(() => {
    let alive = true;
    void passkeysAvailable().then((ok) => {
      if (!alive) return;
      setPlatformReady(ok);
      setWords(unlockWords());
    });
    return () => { alive = false; };
  }, []);

  // A fingerprint button only where a fingerprint can work: this vault has one enrolled,
  // this device can do it, and it hasn't just told us it can't protect the vault key.
  const offerPasskey = platformReady && !!state.config?.hasPasskeys && notice !== "use-password";

  const explain = (result: Extract<UnlockResult, { ok: false }>, from: "passkey" | "password") => {
    switch (result.reason) {
      case "wrong":
      case "invalid-code":
        if (from === "password") setFieldError(WRONG);
        else setPasskeyError("That didn't open the vault. Try again, or use the family password.");
        return;
      case "rate-limited": {
        const message = `Too many tries. Wait ${waitWords(result.retryAfter)}, then try again.`;
        if (from === "password") setFieldError(message);
        else setPasskeyError(message);
        return;
      }
      case "no-passkey-here":
        return setNotice("use-password");
      case "offline-first-time":
        return setNotice("first-time");
      case "key-changed":
        return setNotice("key-changed");
      default: {
        const message = "The vault's storage didn't answer. Try again in a moment.";
        if (from === "password") setFieldError(message);
        else setPasskeyError(message);
      }
    }
  };

  const reset = () => {
    setFieldError(null);
    setPasskeyError(null);
    if (notice === "first-time") setNotice(null);
  };

  const unlockWithPasskey = async () => {
    if (busy) return;
    reset();
    setBusy("passkey");
    try {
      const begun = await rpc.passkeyOptions();
      if (!begun) return setNotice("use-password");
      const { response, prfOutput } = await getAssertion(begun.options, begun.prfSalt);
      const result = await rpc.unlockWithPasskey({ response, prfOutput, online: begun.online });
      prfOutput.fill(0);
      if (!result.ok) explain(result, "passkey");
    } catch (e) {
      if (e instanceof PasskeyCancelled) return; // they changed their mind; nothing to say
      if (e instanceof PrfUnsupported) return setNotice("use-password");
      setPasskeyError("That didn't work. Try again, or use the family password.");
    } finally {
      setBusy(null);
    }
  };

  const unlockWithPassword = async () => {
    if (busy) return;
    reset();
    if (!password) return setFieldError("Enter the family password first.");
    setBusy("password");
    try {
      const result = await rpc.unlockWithPassword(password);
      if (!result.ok) explain(result, "password");
    } catch {
      setFieldError("The vault's storage didn't answer. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  if (view === "help") return <CantGetIn onBack={() => setView("lock")} onUseCode={() => setView("recovery")} />;
  if (view === "recovery") return <RecoveryEntry onBack={() => setView("help")} />;

  const blocked = notice === "key-changed";

  return (
    <AuthScreen
      onSubmit={() => void unlockWithPassword()}
      actions={
        blocked ? undefined : (
          <>
            {offerPasskey && (
              <>
                <Button size="lg" icon={Fingerprint} loading={busy === "passkey"} loadingLabel="Unlocking…" onClick={() => void unlockWithPasskey()}>
                  {words.unlock}
                </Button>
                {passkeyError && <InlineError>{passkeyError}</InlineError>}
                <div className="flex items-center gap-3 text-callout text-ink-3">
                  <span aria-hidden className="h-px flex-1 bg-line" />
                  or use the family password
                  <span aria-hidden className="h-px flex-1 bg-line" />
                </div>
              </>
            )}
            <Field label="Family password" error={fieldError}>
              <PasswordField
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldError) setFieldError(null);
                }}
                autoComplete="current-password"
                enterKeyHint="go"
                readOnly={busy === "password"}
              />
            </Field>
            <Button type="submit" size="lg" variant={offerPasskey ? "secondary" : "primary"} loading={busy === "password"} loadingLabel="Unlocking…">
              Unlock with password
            </Button>
            <WorkingLine active={busy === "password"} label="Unlocking" />
            <Button variant="text" className="self-center" onClick={() => setView("help")}>Can&rsquo;t get in?</Button>
          </>
        )
      }
    >
      <div className="flex flex-col items-start">
        <AppMark />
        <h1 className="mt-5.5 text-display">Family Vault</h1>
        <p className="mt-2.5 flex items-center gap-2 text-body text-ink-2">
          <Icon icon={Lock} className="size-4.5" />
          Locked
        </p>
      </div>

      {notice === "use-password" && (
        <Banner tone="info" title={`This ${words.device}'s ${words.noun} can't protect your vault key`}>
          You&rsquo;ll use the family password here.
        </Banner>
      )}
      {notice === "first-time" && (
        <Banner tone="info" title="This phone needs internet the first time">
          It hasn&rsquo;t opened the vault before, so it has to reach it once. Connect, then try again. After that, documents kept on this phone open without internet.
        </Banner>
      )}
      {blocked && (
        <Banner tone="danger" title="This vault's key changed unexpectedly">
          Something replaced the vault&rsquo;s lock since this phone last opened it. Don&rsquo;t carry on, and don&rsquo;t add anything new. Ask whoever looks after the vault to check it first.
        </Banner>
      )}
    </AuthScreen>
  );
}
