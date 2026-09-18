"use client";

import { KeyRound, LogOut, Smartphone } from "lucide-react";
import { useState } from "react";
import { useVault } from "@/client/vault-provider";
import { NewPasswordFields, useNewPassword } from "@/components/auth/new-password-fields";
import {
  Banner, Button, ConfirmDialog, Group, GroupLabel, Row, Screen, ScreenHeader, Section, Sheet, TopBar, useToast,
} from "@/components/ui";

export default function SecurityPage() {
  const { state, rpc, online } = useVault();
  const { toast } = useToast();
  const form = useNewPassword();
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<"everywhere" | "forget" | null>(null);
  const admin = state.role === "admin";

  const save = async () => {
    setError(undefined);
    const password = await form.validate();
    if (!password) return;
    setBusy(true);
    try {
      await rpc.changePassword(password);
      setChanging(false);
      toast({ message: "Family password changed. Tell the family." });
    } catch {
      setError(online ? "The new password wasn't saved. The old one still works. Try again in a moment." : "You're offline. The old password still works; try again when you're back online.");
    }
    setBusy(false);
  };

  return (
    <Screen gap="lg">
      <TopBar backLabel="Settings" backHref="/settings" />
      <ScreenHeader title="Password and sign-in" size="title" />

      {!admin && (
        <Banner tone="info" title="Some things here need the person who manages the vault">
          You opened the vault with the family password, which everyone shares. Changing it, or signing devices out, is done from a device that manages the vault.
        </Banner>
      )}

      {admin && (
        <Section>
          <GroupLabel>Family password</GroupLabel>
          <Group>
            <Row icon={KeyRound} label="Change the family password" description="Everyone uses the same one, so tell the family afterwards" onClick={() => setChanging(true)} chevron />
          </Group>
          <p className="px-1 pt-2 text-callout text-ink-3">
            A new password stops the old one opening the vault from now on. It can&apos;t take back anything someone already copied while they knew the old one.
          </p>
        </Section>
      )}

      <Section>
        <GroupLabel>Devices</GroupLabel>
        <Group>
          {admin && <Row icon={LogOut} label="Sign out every device" description="Everyone unlocks again, including you" onClick={() => setConfirm("everywhere")} chevron={false} />}
          <Row icon={Smartphone} danger label="Forget the vault on this device" description="Removes the offline copy kept here. Nothing is removed from your vault." onClick={() => setConfirm("forget")} />
        </Group>
      </Section>

      <Sheet open={changing} onOpenChange={setChanging} title="Change the family password">
        {error && <Banner tone="danger" title="Not saved">{error}</Banner>}
        <NewPasswordFields form={form} disabled={busy} />
        <Button size="lg" loading={busy} loadingLabel="Saving…" onClick={() => void save()}>Save new password</Button>
      </Sheet>

      <ConfirmDialog
        open={confirm === "everywhere"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Sign out every device?"
        body="Every phone and computer, including this one, will need to unlock again. Nothing is removed from your vault."
        confirmLabel="Sign out every device"
        onConfirm={() => { setConfirm(null); void rpc.signOutEverywhere().catch(() => toast({ message: "That didn't work. Try again when you're online." })); }}
      />
      <ConfirmDialog
        open={confirm === "forget"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Forget the vault on this device?"
        body={state.sync?.pending
          ? "Some changes made on this device haven't been saved to your storage yet. Forgetting the vault here loses them. Everything already saved stays in your vault."
          : "The offline copy kept here is removed and the vault locks. Everything stays in your vault; this device will need internet to open it again."}
        confirmLabel="Forget on this device"
        onConfirm={() => { setConfirm(null); void rpc.forgetDevice(); }}
      />
    </Screen>
  );
}
