"use client";

import { CircleCheck, CloudOff, HardDrive, Lock, NotebookPen, Users } from "lucide-react";
import { useEffect, useState } from "react";
import type { RpcError } from "@/client/rpc";
import { useVault } from "@/client/vault-provider";
import { Banner, Button, Field, Group, Row, StatusPill, StepProgress, TextInput, TopBar } from "@/components/ui";
import { AuthHeading, AuthScreen, InlineError, WorkingLine, waitWords } from "./auth-screen";
import { isInstalled } from "./install-prompt";
import { NewPasswordFields, useNewPassword } from "./new-password-fields";
import type { RecoveryKitInfo } from "./recovery-kit";
import { SetupInstallStep } from "./setup-install-step";
import { SetupPasskeyStep } from "./setup-passkey-step";
import { SetupRecoveryStep } from "./setup-recovery-step";
import { endSetup, getSetupStep, isSetupActive, setSetupProgress } from "./setup-state";
import { RestoreFlow } from "./restore-flow";
import { SetupTestStep } from "./setup-test-step";

const TOTAL = 6;
/** one past the numbered steps: the install screen */
const INSTALL = TOTAL + 1;

/** Two different groups to ask back, in order. Random, so nobody learns "it's always the third". */
function pickTwoGroups(): [number, number] {
  const pick = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const a = pick(8);
  let b = pick(7);
  if (b >= a) b += 1;
  return a < b ? [a, b] : [b, a];
}

/**
 * §36: Welcome → storage → family password → recovery code (blocking) → this
 * phone's fingerprint → round-trip test (blocking) → install.
 *
 * Nothing leaves the device until the recovery code has been typed back. The
 * vault is created at that moment, which unlocks the app underneath — so from
 * step 5 on, `setup-state` is what keeps this flow on screen.
 */
export function SetupFlow() {
  const { state, rpc } = useVault();
  const [step, setStep] = useState(() => (isSetupActive() ? getSetupStep() : 1));
  const [setupToken, setSetupToken] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [made, setMade] = useState<{ forPassword: string; kit: RecoveryKitInfo; ask: [number, number] } | null>(null);
  const form = useNewPassword();

  const storage = state.config?.storage;
  const tokenRequired = !!state.config?.setupTokenRequired;

  const go = (next: number) => {
    setStep(next);
    if (isSetupActive()) setSetupProgress({ step: next });
    window.scrollTo({ top: 0 });
  };

  // Someone else finished setting up while this was open: the vault exists, so this becomes the lock screen.
  useEffect(() => {
    if (state.phase === "locked") endSetup();
  }, [state.phase]);

  const bar = (n: number, back?: () => void) => (
    <>
      <TopBar backLabel={back ? "Back" : undefined} onBack={back} trailing={`Step ${n} of ${TOTAL}`} />
      <StepProgress current={n} total={TOTAL} />
    </>
  );

  // ── 2 → 3
  const leaveStorage = async () => {
    if (!storage?.ok) {
      setChecking(true);
      await rpc.loadConfig().catch(() => {});
      return setChecking(false);
    }
    if (tokenRequired && !setupToken.trim()) return setTokenError("Enter the setup code. Whoever put this site online has it.");
    go(3);
  };

  // ── 3 → 4: make the vault key and the recovery code, in memory only
  const leavePassword = async () => {
    if (preparing) return;
    setPrepareError(null);
    const password = await form.validate();
    if (!password) return;
    // Going back and forward must not mint a second code: the first may already be on paper.
    if (made?.forPassword === password) return go(4);
    setPreparing(true);
    try {
      const { groups } = await rpc.beginSetup(password);
      setMade({
        forPassword: password,
        ask: pickTwoGroups(),
        kit: {
          groups,
          appUrl: window.location.origin,
          storage: { provider: storage?.provider, location: storage?.location },
          madeOn: new Date().toISOString(),
        },
      });
      go(4);
    } catch {
      setPrepareError("Couldn't get the vault ready on this device. Try again.");
    } finally {
      setPreparing(false);
    }
  };

  // ── 4 → 5: the code has been typed back, so the vault gets created
  const createVault = async (): Promise<string | null> => {
    setSetupProgress({ active: true, step: 5 });
    try {
      await rpc.completeSetup(tokenRequired ? setupToken.trim() : undefined);
      go(5);
      return null;
    } catch (e) {
      endSetup();
      const err = e as RpcError;
      if (err.code === "setup-token") {
        setTokenError("That setup code isn't right. Check it with whoever put this site online.");
        go(2);
        return null;
      }
      if (err.code === "already-initialized") {
        await rpc.loadConfig().catch(() => {});
        return "Someone has already set up this vault. Unlock it with the family password instead.";
      }
      if (err.status === 429) return `Too many tries. Wait ${waitWords(err.retryAfter)}, then try again.`;
      if (err.code === "storage-unavailable") return `The vault's storage isn't ready${err.detail ? `: ${err.detail}` : ""}. Fix that, then try again.`;
      if (err.name === "TypeError") return "Couldn't reach the vault's storage. Check your connection, then try again.";
      return "The vault wasn't created. Try again in a moment.";
    }
  };

  const finish = () => endSetup();


  if (restoring) return <RestoreFlow onBack={() => setRestoring(false)} />;

  switch (step) {
    case 1:
      return (
        <AuthScreen
          bar={bar(1)}
          actions={
            <>
              <Button size="lg" onClick={() => go(2)}>Get started</Button>
              <Button variant="text" className="self-center" onClick={() => setRestoring(true)}>Restore from a backup</Button>
            </>
          }
        >
          <AuthHeading title="A safe place for the family's papers">
            <p>Passports, Aadhaar cards, insurance, certificates: the documents you go looking for at the worst moments. Family Vault keeps a locked copy of each, where the whole family can find it.</p>
          </AuthHeading>
          <Group>
            <Row icon={Lock} label="Locked on your phone first" description="Documents are locked before they leave this phone. Only your family can open them." />
            <Row icon={CloudOff} label="Opens without internet" description="Documents kept on this phone still open at a counter with no signal." />
            <Row icon={Users} label="One vault for the whole family" description="Everyone shares one family password, and anyone who can unlock can see every document." />
            <Row icon={NotebookPen} label="Have a pen and paper ready" description="Setting up takes about five minutes, and one step is writing down a recovery code." />
          </Group>
        </AuthScreen>
      );

    case 2:
      return (
        <AuthScreen
          onSubmit={() => void leaveStorage()}
          bar={bar(2, () => go(1))}
          actions={
            <Button type="submit" size="lg" loading={checking} loadingLabel="Checking…">
              {storage?.ok ? "Continue" : "Check again"}
            </Button>
          }
        >
          <AuthHeading title="Where your vault is kept">
            <p>Your locked documents are saved here. Whoever put this site online chose it.</p>
          </AuthHeading>
          {storage?.ok ? (
            <Group>
              <Row
                icon={HardDrive}
                label={storage.provider ?? "Storage"}
                description={storage.location}
                trailing={<StatusPill tone="good" icon={CircleCheck}>Connected</StatusPill>}
              />
            </Group>
          ) : (
            <Banner tone="danger" title="The vault's storage isn't ready">
              {storage?.problem ?? "It didn't answer."}
              {storage?.missing?.length ? ` Still to be set on the server: ${storage.missing.join(", ")}.` : ""}
            </Banner>
          )}
          <Banner tone="info" title="Keep this web address for good">
            Fingerprint and face unlock are tied to {typeof window === "undefined" ? "this address" : window.location.host}. If the vault ever moves to a different address, every phone goes back to the family password.
          </Banner>
          {tokenRequired && (
            <Field label="Setup code" error={tokenError} helper="Whoever put this site online set one, so that only they can create the vault.">
              <TextInput
                value={setupToken}
                onChange={(e) => {
                  setSetupToken(e.target.value);
                  setTokenError(null);
                }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
          )}
        </AuthScreen>
      );

    case 3:
      return (
        <AuthScreen
          onSubmit={() => void leavePassword()}
          bar={bar(3, () => go(2))}
          actions={
            <>
              {prepareError && <InlineError>{prepareError}</InlineError>}
              <Button type="submit" size="lg" loading={preparing} loadingLabel="Getting ready…">Continue</Button>
              <WorkingLine active={preparing} label="Getting your vault ready" />
            </>
          }
        >
          <AuthHeading title="Choose the family password">
            <p>One password for the whole family. It opens the vault on any phone or computer, so pick one everyone can remember and nobody could guess.</p>
          </AuthHeading>
          <NewPasswordFields form={form} disabled={preparing} />
        </AuthScreen>
      );

    case 4:
      // only reachable with a code in hand; anything else goes back to make one
      if (!made) return <Redirect to={() => go(3)} />;
      return <SetupRecoveryStep bar={bar(4, () => go(3))} kit={made.kit} ask={made.ask} onConfirmed={createVault} />;

    case 5:
      return <SetupPasskeyStep bar={bar(5)} onDone={() => go(6)} />;

    case 6:
      return <SetupTestStep bar={bar(6)} onDone={() => (isInstalled() ? finish() : go(INSTALL))} />;

    default:
      return <SetupInstallStep onDone={finish} />;
  }
}

function Redirect({ to }: { to: () => void }) {
  useEffect(() => to(), [to]);
  return null;
}
