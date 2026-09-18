"use client";

import { Fingerprint, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  PasskeyCancelled, PrfUnsupported, createCredential, passkeysAvailable, suggestedDeviceLabel, unlockWords,
} from "@/client/passkey";
import type { DeviceInfo } from "@/client/session-core";
import { useVault } from "@/client/vault-provider";
import {
  Banner, Button, ConfirmDialog, Field, Group, GroupLabel, Row, Screen, ScreenHeader, Section, Sheet, SkeletonRows,
  StatusPill, TextInput, TopBar, useToast,
} from "@/components/ui";
import { formatDate } from "@/lib/format";

export default function DevicesPage() {
  const { state, rpc, online } = useVault();
  const { toast } = useToast();
  const words = unlockWords();
  const admin = state.role === "admin";

  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [canEnrol, setCanEnrol] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState(suggestedDeviceLabel());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"unsupported" | "failed" | null>(null);
  const [selected, setSelected] = useState<DeviceInfo | null>(null);
  const [removing, setRemoving] = useState<DeviceInfo | null>(null);

  const load = useCallback(() => rpc.devices().then(setDevices).catch(() => setDevices([])), [rpc]);
  useEffect(() => { void load(); void passkeysAvailable().then(setCanEnrol); }, [load]);

  const thisDeviceEnrolled = devices?.some((d) => d.current) ?? false;

  const enrol = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const options = (await rpc.enrolOptions()) as Record<string, unknown>;
      const prfSalt = state.config?.prfSalt;
      if (!prfSalt) throw new Error("no salt");
      const created = await createCredential(options, prfSalt);
      const role = await rpc.enrolPasskey({ ...created, label: label.trim() });
      setAdding(false);
      toast({ message: role === "admin" ? `Added ${label.trim()}. It can manage the vault.` : `Added ${label.trim()}` });
      await load();
    } catch (e) {
      if (e instanceof PrfUnsupported) setNotice("unsupported");
      else if (!(e instanceof PasskeyCancelled)) setNotice("failed");
    }
    setBusy(false);
  };

  return (
    <Screen gap="lg">
      <TopBar backLabel="Settings" backHref="/settings" />
      <ScreenHeader title="Devices" size="title">
        Phones and computers that can open the vault with their own {words.noun}, without typing the family password.
      </ScreenHeader>

      {notice === "unsupported" && (
        <Banner tone="info" title={`This ${words.device}'s ${words.noun} can't protect your vault key`}>
          You&apos;ll use the family password here. Nothing is wrong with your vault.
        </Banner>
      )}
      {notice === "failed" && <Banner tone="danger" title="That didn't work">Check your internet connection and try again.</Banner>}

      <Section>
        <GroupLabel>Can open the vault</GroupLabel>
        {devices === null ? <Group busy><SkeletonRows count={2} /></Group> : devices.length === 0 ? (
          <p className="px-1 text-callout text-ink-2">No devices yet. Right now the family password is the only everyday way in.</p>
        ) : (
          <Group>
            {devices.map((d) => (
              <Row
                key={d.envelopeId}
                icon={Smartphone}
                label={d.label ?? "Unnamed device"}
                description={`Added ${formatDate(d.createdAt)}${d.role === "admin" ? " · Can manage the vault" : ""}`}
                trailing={d.current ? <StatusPill tone="good" icon={Fingerprint}>This device</StatusPill> : undefined}
                onClick={admin ? () => setSelected(d) : undefined}
                chevron={admin}
              />
            ))}
          </Group>
        )}
      </Section>

      <p className="text-callout text-ink-2">
        To add another phone, open Family Vault on it, unlock with the family password, then come back to this screen on that phone.
      </p>

      {canEnrol && !thisDeviceEnrolled && devices !== null && (
        <div className="mt-auto">
          <Button size="lg" icon={Fingerprint} onClick={() => (online ? setAdding(true) : setNotice("failed"))}>{words.add}</Button>
        </div>
      )}

      <Sheet open={adding} onOpenChange={setAdding} title={words.add}>
        <Field label="Name for this device" helper="So you can tell your devices apart later. Only your family can read it.">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
        </Field>
        <Button size="lg" icon={Fingerprint} loading={busy} loadingLabel="Waiting for you…" onClick={() => void enrol()}>Continue</Button>
      </Sheet>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)} title={selected?.label ?? "Device"}>
        {selected && (
          <>
            <Group>
              <Row
                label="Can manage the vault"
                description="Delete permanently, remove devices, change the family password"
                checked={selected.role === "admin"}
                onCheckedChange={(v) => {
                  const role = v ? "admin" : "member";
                  void rpc.setDeviceRole(selected.credentialId, role)
                    .then(() => { setSelected({ ...selected, role }); return load(); })
                    .catch(() => toast({ message: "At least one device has to be able to manage the vault." }));
                }}
              />
            </Group>
            <Group>
              <Row danger label="Remove this device" onClick={() => { setRemoving(selected); setSelected(null); }} />
            </Group>
          </>
        )}
      </Sheet>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.label ?? "this device"}?`}
        body="It won't be able to unlock the vault again. Documents it already opened may have been copied while it had access."
        confirmLabel="Remove device"
        onConfirm={() => {
          if (!removing) return;
          const name = removing.label ?? "the device";
          void rpc.removeDevice(removing.credentialId)
            .then(() => { toast({ message: `Removed ${name}. It can't unlock the vault again.` }); return load(); })
            .catch(() => toast({ message: "That didn't work. Try again when you're online." }));
          setRemoving(null);
        }}
      />
    </Screen>
  );
}
