"use client";

import { Circle, CircleCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVault } from "@/client/vault-provider";
import { Banner, Button, Group, Icon, Spinner, cn } from "@/components/ui";
import { AuthHeading, AuthScreen } from "./auth-screen";

const STEPS = [
  { id: "encrypt", label: "Locked a test file on this phone" },
  { id: "upload", label: "Saved it to your storage" },
  { id: "download", label: "Fetched it back" },
  { id: "verify", label: "Opened it and checked every byte" },
  { id: "cleanup", label: "Tidied up" },
] as const;

type StepId = (typeof STEPS)[number]["id"];
type Outcome = "running" | "passed" | "failed";

/**
 * §36 step 6. Setup doesn't report success until a real file has made the whole
 * trip and come back identical. A vault that can't round-trip isn't a vault.
 */
export function SetupTestStep({ bar, onDone }: { bar: React.ReactNode; onDone: () => void }) {
  const { rpc } = useVault();
  const [active, setActive] = useState<number>(0);
  const [outcome, setOutcome] = useState<Outcome>("running");
  const started = useRef(false);

  const run = useCallback(async () => {
    setOutcome("running");
    setActive(0);
    try {
      const ok = await rpc.selfTest((step: StepId) => setActive(STEPS.findIndex((s) => s.id === step)));
      if (ok) setActive(STEPS.length);
      setOutcome(ok ? "passed" : "failed");
    } catch {
      setOutcome("failed");
    }
  }, [rpc]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  return (
    <AuthScreen
      bar={bar}
      actions={
        outcome === "passed" ? <Button size="lg" onClick={onDone}>Continue</Button>
        : outcome === "failed" ? <Button size="lg" onClick={() => void run()}>Try again</Button>
        : undefined
      }
    >
      <AuthHeading title={outcome === "passed" ? "Everything works" : "Checking everything works…"}>
        <p>
          {outcome === "passed"
            ? "A test file made the whole trip and came back exactly as it left. Your vault is ready."
            : "A small test file goes all the way out and comes all the way back, to prove your documents will too."}
        </p>
      </AuthHeading>

      <Group>
        <ol aria-live="polite">
          {STEPS.map((step, i) => {
            const done = i < active;
            const current = i === active && outcome === "running";
            return (
              <li
                key={step.id}
                className={cn(
                  "relative flex min-h-14 items-center gap-3 px-4 py-2.5 text-label",
                  "before:absolute before:top-0 before:right-0 before:left-12 before:h-px before:bg-line before:content-[''] first:before:hidden",
                  done ? "text-ink" : current ? "text-ink-2" : "text-ink-3",
                )}
              >
                {done ? <Icon icon={CircleCheck} className="size-5 text-good" />
                  : current ? <Spinner className="size-5 text-ink-2" />
                  : <Icon icon={Circle} className="size-5" />}
                <span>{step.label}</span>
                <span className="sr-only">{done ? "(done)" : current ? "(in progress)" : "(waiting)"}</span>
              </li>
            );
          })}
        </ol>
      </Group>

      {outcome === "failed" && (
        <Banner tone="danger" title="The test file didn't make it back">
          Your vault was created, but it couldn&rsquo;t save and fetch a file just now. Check this phone&rsquo;s connection, then try again. Don&rsquo;t add real documents until this passes.
        </Banner>
      )}
    </AuthScreen>
  );
}
