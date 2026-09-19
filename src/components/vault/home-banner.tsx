"use client";

import { CloudOff, FileQuestion, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { PasskeyCancelled, getAssertion, passkeysAvailable, unlockWords } from "@/client/passkey";
import { useVault } from "@/client/vault-provider";
import { Banner, useToast } from "@/components/ui";
import { getSetting } from "@/lib/documents";
import { daysFromToday, plural } from "@/lib/format";
import type { Orphan } from "@/vault/engine";
import { cachedOrphans, setCachedOrphans } from "./memory";

const ORPHAN_CHECK_DELAY_MS = 4000;

/** "Passport — Dad, and 2 others". Files we couldn't read are counted, not named. */
function orphanNames(orphans: Orphan[]): string {
  const named = orphans.filter((o) => o.name).map((o) => o.name!);
  if (named.length === 0) return "";
  const others = orphans.length - 1;
  return others > 0 ? ` — ${named[0]}, and ${plural(others, "other")}` : ` — ${named[0]}`;
}

/**
 * The one notice at the top of Documents. One at a time, most urgent first:
 * something that stops changes being saved, then being offline, then files that
 * need rescuing, then the standing warning about how this vault can be opened.
 */
export function HomeBanner() {
  const { state, rpc, online } = useVault();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [orphans, setOrphans] = useState<Orphan[]>(() => cachedOrphans() ?? []);
  const [canAddPasskey, setCanAddPasskey] = useState(false);

  const isAdmin = state.role === "admin";
  const hasSession = !state.needsSession;

  // §7.8: look for uploads that never made it into the index. Once per unlock, quietly, a few seconds in.
  useEffect(() => {
    if (!online || !hasSession || cachedOrphans() !== null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc.findOrphans().then(
        (found) => {
          setCachedOrphans(found);
          if (!cancelled) setOrphans(found);
        },
        () => {}, // couldn't look; try again next time Documents opens
      );
    }, ORPHAN_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [online, hasSession, rpc]);

  useEffect(() => {
    let cancelled = false;
    void passkeysAvailable().then((ok) => { if (!cancelled) setCanAddPasskey(ok); });
    return () => { cancelled = true; };
  }, []);

  const saveNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (state.via !== "passkey") {
        // a password unlock can sign back in by itself; a sync is what triggers it
        await rpc.syncNow();
        return;
      }
      const options = await rpc.passkeyOptions();
      if (!options?.online) {
        toast({ message: "Still no internet. Your changes are safe on this phone." });
        return;
      }
      const assertion = await getAssertion(options.options, options.prfSalt);
      assertion.prfOutput.fill(0); // the vault's already open; only the sign-in half is needed
      const ok = await rpc.resumeSession(assertion.response);
      toast({ message: ok ? "Your changes are saving" : "That didn't work. Try again in a moment." });
    } catch (e) {
      if (!(e instanceof PasskeyCancelled)) toast({ message: "That didn't work. Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  const recover = async () => {
    if (busy) return;
    setBusy(true);
    const readable = orphans.filter((o) => o.readable).map((o) => o.id);
    try {
      await rpc.recoverOrphans(readable);
      const rest = orphans.filter((o) => !o.readable);
      setCachedOrphans(rest);
      setOrphans(rest);
      toast({ message: `Saved ${plural(readable.length, "document")} to your vault` });
    } catch {
      toast({ message: "Couldn't save them just now. Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await rpc.discardOrphans(orphans.map((o) => o.id));
      setCachedOrphans([]);
      setOrphans([]);
      toast({ message: `Removed ${plural(orphans.length, "file")} from your vault` });
    } catch {
      toast({ message: "Couldn't remove them just now. Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  if (state.needsSession && online) {
    return (
      <Banner
        tone="info"
        title="Unlock again to save your changes"
        action={{ label: state.via === "passkey" ? unlockWords().unlock : "Save changes now", onClick: () => void saveNow() }}
      >
        You opened the vault without internet. Everything you changed is safe on this phone, and it saves once you unlock again.
      </Banner>
    );
  }

  const problem = state.sync?.problem;
  if (online && (problem === "server" || problem === "conflict")) {
    return (
      <Banner
        tone="danger"
        title="Some changes haven't been saved yet"
        action={{ label: "Try again", onClick: () => void rpc.syncNow() }}
        secondaryAction={{ label: "What went wrong", href: "/settings/technical" }}
      >
        They&apos;re safe on this phone, and we&apos;ll keep trying.
      </Banner>
    );
  }

  if (!online || problem === "offline") {
    return (
      <Banner tone="info" icon={CloudOff} title="You're offline">
        Documents on this phone still open. Changes will save when you&apos;re back online.
      </Banner>
    );
  }

  if (orphans.length > 0) {
    const recoverable = orphans.some((o) => o.readable);
    return (
      <Banner
        tone="info"
        icon={FileQuestion}
        title={`${plural(orphans.length, "file")} ${orphans.length === 1 ? "was" : "were"} uploaded but not saved to your vault${orphanNames(orphans)}`}
        action={recoverable ? { label: "Recover", onClick: () => void recover() } : undefined}
        // removing files from the store is an admin's call (§21.1); for everyone else it isn't offered at all
        secondaryAction={isAdmin ? { label: "Discard", onClick: () => void discard() } : undefined}
      >
        An upload was interrupted before it finished. Nothing is lost.
      </Banner>
    );
  }

  // §20.3. All we know here is whether any device can unlock by itself yet, so that's all this claims.
  if (state.config?.hasPasskeys === false && canAddPasskey) {
    const words = unlockWords();
    return (
      <Banner
        tone="warn"
        title="Only the family password opens this vault"
        action={{ label: `Add this ${words.device}`, href: "/settings/devices" }}
        secondaryAction={{ label: "Recovery code", href: "/settings/recovery" }}
      >
        If the password is forgotten, the recovery code is the only way back in. Adding this {words.device}&apos;s {words.noun} gives the family a second way.
      </Banner>
    );
  }

  // §20.4. An untested backup is a rumour. Twice a year, one family member is asked
  // whether the paper can still be found. The answer is kept in the vault, not on
  // this device, so one person saying yes settles it for everyone.
  const index = state.index;
  if (index && online && hasSession) {
    const checked = getSetting<string | null>(index, RECOVERY_CHECKED, null);
    // a vault with no answer yet starts its clock from its oldest document, or from now
    const since = checked ?? Object.values(index.entries).map((e) => e.createdAt).sort()[0];
    if (since && -daysFromToday(since) >= RECOVERY_DRILL_DAYS) {
      return (
        <Banner
          tone="info"
          icon={KeyRound}
          title="Can you still find your recovery code?"
          action={{ label: "Yes, found it", onClick: () => { void rpc.setSetting(RECOVERY_CHECKED, new Date().toISOString()); toast({ message: "Good. We'll ask again in six months." }); } }}
          secondaryAction={{ label: "No, make a new one", href: "/settings/recovery" }}
        >
          It&apos;s the paper you wrote when the vault was set up. If the family password is ever forgotten, it&apos;s the only way back in. Go and look before you answer.
        </Banner>
      );
    }
  }

  return null;
}

const RECOVERY_CHECKED = "recoveryCheckedAt";
const RECOVERY_DRILL_DAYS = 180;
