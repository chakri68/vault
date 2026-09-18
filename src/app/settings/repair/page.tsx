"use client";

import { CircleCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVault } from "@/client/vault-provider";
import { Banner, Button, ProgressBar, Screen, ScreenHeader, TopBar } from "@/components/ui";
import { plural } from "@/lib/format";

type Phase = { kind: "idle" } | { kind: "running"; done: number; total: number } | { kind: "done"; recovered: number; unreadable: number } | { kind: "failed" };

/** §8.4. No cancel and no bottom bar while it runs: half an index is worse than none. */
export default function RepairPage() {
  const { state, rpc } = useVault();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const started = useRef(false);

  const run = useCallback(async () => {
    setPhase({ kind: "running", done: 0, total: 0 });
    try {
      const result = await rpc.rebuild((done, total) => setPhase({ kind: "running", done, total }));
      setPhase({ kind: "done", ...result });
    } catch {
      setPhase({ kind: "failed" });
    }
  }, [rpc]);

  // an index that won't open is rebuilt without being asked
  useEffect(() => {
    if (!state.needsRepair || started.current) return;
    started.current = true;
    void run();
  }, [state.needsRepair, run]);

  const running = phase.kind === "running";
  const percent = running && phase.total ? Math.round((phase.done / phase.total) * 100) : undefined;

  return (
    <Screen gap="lg">
      {!running && !state.needsRepair && <TopBar backLabel="Settings" backHref="/settings" />}
      <ScreenHeader title={running || phase.kind === "done" ? "Rebuilding your vault index" : "Repair vault"} size="title">
        {phase.kind === "idle" && !state.needsRepair &&
          "If documents are missing from your lists, or names look out of date, this rebuilds the list from the label on each file. It can't lose a document. Anything in the trash may come back as a normal document."}
      </ScreenHeader>

      {running && (
        <>
          <ProgressBar label={phase.total ? `Reading ${plural(phase.total, "document")}…` : "Looking at what's stored…"} value={percent} />
          <p className="text-callout text-ink-2">Nothing is downloaded in full, only the small label on each file.</p>
        </>
      )}

      {phase.kind === "done" && (
        <Banner tone="info" icon={CircleCheck} title={`Found ${plural(phase.recovered, "document")}`}>
          {phase.unreadable > 0
            ? `${plural(phase.unreadable, "file")} couldn't be read and ${phase.unreadable === 1 ? "was" : "were"} left alone. A backup may have a good copy.`
            : "Everything that's stored is back in your lists."}
        </Banner>
      )}

      {phase.kind === "failed" && (
        <Banner tone="danger" title="The rebuild didn't finish">
          Nothing was changed. Check your internet connection and try again.
        </Banner>
      )}

      <div className="mt-auto">
        {phase.kind === "idle" && !state.needsRepair && <Button size="lg" onClick={() => void run()}>Rebuild now</Button>}
        {phase.kind === "failed" && <Button size="lg" onClick={() => void run()}>Try again</Button>}
        {phase.kind === "done" && <Button size="lg" onClick={() => router.replace("/")}>Done</Button>}
      </div>
    </Screen>
  );
}
