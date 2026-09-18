"use client";

import { useEffect, useRef, useState } from "react";
import { Field, PasswordField, cn } from "@/components/ui";
import { STRENGTH_STEPS, type Strength, measureStrength, preloadStrength } from "@/lib/password-strength";

const EXAMPLE = "“mango tree monsoon kettle”";

/**
 * Four segments and a word. The word carries the meaning; the fill only echoes
 * it, so this still reads with no colour at all (§38).
 */
export function StrengthMeter({ strength }: { strength: Strength | null }) {
  const filled = strength ? strength.level + 1 : 0;
  const tone = !strength ? "bg-sunken-pressed" : strength.acceptable ? "bg-good" : strength.level === 0 ? "bg-danger" : "bg-warn";
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div aria-hidden className="flex gap-1">
        {Array.from({ length: STRENGTH_STEPS }, (_, i) => (
          <span key={i} className={cn("h-1.5 flex-1 rounded-full transition-colors duration-150", i < filled ? tone : "bg-sunken-pressed")} />
        ))}
      </div>
      <p className="text-callout font-semibold text-ink-2">
        {strength ? strength.label : <span className="font-normal text-ink-3">Type a password to see how strong it is</span>}
      </p>
    </div>
  );
}

export interface NewPasswordState {
  password: string;
  confirm: string;
  strength: Strength | null;
  errors: { password?: string; confirm?: string };
}

/**
 * Two fields, a live estimate, and validation that runs when the button is
 * pressed (the button stays enabled; a greyed-out button explains nothing).
 */
export function useNewPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<Strength | null>(null);
  const [errors, setErrors] = useState<NewPasswordState["errors"]>({});
  const latest = useRef(0);

  useEffect(() => preloadStrength(), []);

  const onPassword = (value: string) => {
    setPassword(value);
    setErrors((e) => ({ ...e, password: undefined }));
    const run = ++latest.current;
    if (!value) return setStrength(null);
    void measureStrength(value).then((s) => {
      if (run === latest.current) setStrength(s);
    }).catch(() => {});
  };

  const onConfirm = (value: string) => {
    setConfirm(value);
    setErrors((e) => ({ ...e, confirm: undefined }));
  };

  /** Returns the password when it's good to use, else sets the errors and returns null. */
  const validate = async (): Promise<string | null> => {
    if (!password) {
      setErrors({ password: "Choose a family password first." });
      return null;
    }
    let measured: Strength;
    try {
      measured = await measureStrength(password);
    } catch {
      setErrors({ password: "Couldn't check that password. Check your connection and try again." });
      return null;
    }
    setStrength(measured);
    if (!measured.acceptable) {
      setErrors({ password: `That one's too easy to guess. Try four unrelated words, like ${EXAMPLE}, but your own.` });
      return null;
    }
    if (confirm !== password) {
      setErrors({ confirm: confirm ? "These don't match. Type the same password in both boxes." : "Type the password once more, so a slip doesn't lock you out." });
      return null;
    }
    return password;
  };

  return { password, confirm, strength, errors, onPassword, onConfirm, validate };
}

export function NewPasswordFields({ form, disabled }: { form: ReturnType<typeof useNewPassword>; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Field
          label="Family password"
          error={form.errors.password}
          helper={`Four unrelated words work well, like ${EXAMPLE}. Everyone in the family uses this one.`}
        >
          <PasswordField
            value={form.password}
            onChange={(e) => form.onPassword(e.target.value)}
            autoComplete="new-password"
            readOnly={disabled}
          />
        </Field>
        <StrengthMeter strength={form.strength} />
      </div>
      <Field label="Type it again" error={form.errors.confirm}>
        <PasswordField
          value={form.confirm}
          onChange={(e) => form.onConfirm(e.target.value)}
          autoComplete="new-password"
          readOnly={disabled}
        />
      </Field>
    </div>
  );
}
