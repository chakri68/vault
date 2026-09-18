"use client";

import { Fingerprint } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  PasskeyCancelled, PrfUnsupported, createCredential, passkeysAvailable, suggestedDeviceLabel, unlockWords,
} from "@/client/passkey";
import { useVault } from "@/client/vault-provider";
import { Banner, Button, Field, TextInput } from "@/components/ui";
import { AuthHeading, AuthScreen, InlineError } from "./auth-screen";

/**
 * §36 step 5. Optional, and honest when it can't work: a device whose screen
 * lock can't protect the vault key gets told so and uses the family password.
 * We don't invent a second-rate key with nowhere safe to live (§5.1).
 */
export function SetupPasskeyStep({ bar, onDone }: { bar: React.ReactNode; onDone: () => void }) {
  const { state, rpc } = useVault();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [words] = useState(() => unlockWords());
  const [label, setLabel] = useState(() => suggestedDeviceLabel());
  const [labelError, setLabelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(state);

  useEffect(() => { latest.current = state; }, [state]);

  useEffect(() => {
    let alive = true;
    void passkeysAvailable().then((ok) => { if (alive) setAvailable(ok); });
    return () => { alive = false; };
  }, []);

  const add = async () => {
    if (busy) return;
    setError(null);
    if (!label.trim()) return setLabelError(`Give this ${words.device} a name, like “Mom’s phone”.`);
    setBusy(true);
    try {
      const options = (await rpc.enrolOptions()) as Record<string, unknown>;
      let prfSalt = latest.current.config?.prfSalt;
      if (!prfSalt) {
        await rpc.loadConfig();
        await new Promise((r) => setTimeout(r, 50)); // let the pushed state land
        prfSalt = latest.current.config?.prfSalt;
      }
      if (!prfSalt) throw new Error("no salt");
      const { response, prfOutput } = await createCredential(options, prfSalt);
      await rpc.enrolPasskey({ response, prfOutput, label: label.trim() });
      prfOutput.fill(0);
      onDone();
    } catch (e) {
      if (e instanceof PasskeyCancelled) return; // they backed out of the prompt; say nothing
      if (e instanceof PrfUnsupported) return setUnsupported(true);
      setError(`That didn't work. Try again, or choose Not now and add it later in Settings.`);
    } finally {
      setBusy(false);
    }
  };

  if (available === false || unsupported) {
    return (
      <AuthScreen bar={bar} actions={<Button size="lg" onClick={onDone}>Continue</Button>}>
        <AuthHeading title="You'll use the family password here" />
        <Banner tone="info" title={`This ${words.device}'s ${words.noun} can't protect your vault key`}>
          You&rsquo;ll use the family password here. Other phones in the family may still be able to use theirs.
        </Banner>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      onSubmit={() => void add()}
      bar={bar}
      actions={
        <>
          {error && <InlineError>{error}</InlineError>}
          <Button type="submit" size="lg" icon={Fingerprint} loading={busy} loadingLabel="Waiting for you…">
            {words.add}
          </Button>
          <Button variant="text" className="self-center" onClick={onDone}>Not now</Button>
        </>
      }
    >
      <AuthHeading title={`Open the vault with your ${words.noun}`}>
        <p>Next time, this {words.device} opens the vault without typing. The family password keeps working here and everywhere else.</p>
        <p>Your {words.device} may ask for your {words.noun} twice. That&rsquo;s expected.</p>
      </AuthHeading>
      <Field
        label={`Name for this ${words.device}`}
        error={labelError}
        helper="So you can tell your devices apart later. Only your family can see it."
      >
        <TextInput
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            setLabelError(null);
          }}
          maxLength={60}
          autoComplete="off"
          readOnly={busy}
        />
      </Field>
    </AuthScreen>
  );
}
