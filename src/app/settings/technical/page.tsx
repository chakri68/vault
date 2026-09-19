"use client";

import { useEffect, useState } from "react";
import { useVault } from "@/client/vault-provider";
import { Group, GroupLabel, KeyValueRow, Screen, ScreenHeader, Section, TopBar } from "@/components/ui";
import { formatBytes } from "@/lib/format";

/**
 * §35: the jargon the rest of the app avoids lives here, complete and honest,
 * for anyone who wants to check the claims.
 */
export default function TechnicalPage() {
  const { state } = useVault();
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const config = state.config;
  const kdf = config?.kdf?.params;

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, []);

  const entries = Object.values(state.index?.entries ?? {});
  const stored = entries.reduce((n, e) => n + e.encryptedSize, 0);

  return (
    <Screen gap="lg">
      <TopBar backLabel="Settings" backHref="/settings" />
      <ScreenHeader title="Technical details" size="title">
        What this app actually does with your documents, without the plain-words filter.
      </ScreenHeader>

      <Section>
        <GroupLabel>This deployment</GroupLabel>
        <Group>
          <KeyValueRow label="Source commit" value={config?.commit ? config.commit.slice(0, 12) : "Not published by this host"} mono={!!config?.commit} />
          <KeyValueRow label="Origin" value={typeof location === "undefined" ? "" : location.origin} />
          <KeyValueRow label="Passkey domain (RP ID)" value={config?.rpId ?? ""} />
        </Group>
        <p className="px-1 pt-2 text-callout text-ink-3">
          Compare the commit with the public source to check the code serving this page is the code you expect.
          Passkeys are tied to this domain: if the app moves, every fingerprint unlock stops working and the family password or recovery code is the way in.
        </p>
      </Section>

      <Section>
        <GroupLabel>Encryption</GroupLabel>
        <Group>
          <KeyValueRow label="Cipher" value="AES-256-GCM, 96-bit random nonce per operation" />
          <KeyValueRow label="Keys" value="One random key per file, wrapped by the vault master key" />
          <KeyValueRow label="Password KDF" value={kdf ? `Argon2id · ${Math.round(kdf.memory / 1024)} MiB · t=${kdf.iterations} · p=${kdf.parallelism}` : "Argon2id"} />
          <KeyValueRow label="Key separation" value="HKDF-SHA-256: sign-in secret and key-wrapping key are derived separately" />
          <KeyValueRow label="Passkeys" value="WebAuthn PRF extension; the secret never leaves the authenticator" />
          <KeyValueRow label="Integrity" value="GCM tag, plus SHA-256 of the plaintext sealed in the header" />
          <KeyValueRow label="Size padding" value="16 KB · 64 KB · 256 KB · 1 MB · then whole MBs; labels to 4 KB" />
          <KeyValueRow label="Vault format" value={`v${config?.formatVersion ?? 1}`} />
          <KeyValueRow label="Vault ID" value={config?.vaultId ?? ""} mono />
        </Group>
        <p className="px-1 pt-2 text-callout text-ink-3">
          Everything is encrypted in this browser before it is sent. The server and the storage provider only ever hold ciphertext,
          opaque ids, and secrets they can verify but not use. The master key lives in a background worker&apos;s memory while unlocked and
          nowhere else; JavaScript can&apos;t guarantee memory is wiped on lock, only that every reference is dropped.
        </p>
      </Section>

      <Section>
        <GroupLabel>What the storage provider can see</GroupLabel>
        <Group>
          <KeyValueRow label="Number of files" value="Yes" />
          <KeyValueRow label="Size of each file" value="Only its padded size bucket" />
          <KeyValueRow label="When the vault was written" value="Yes" />
          <KeyValueRow label="Names, people, categories, dates, numbers, contents" value="No" />
        </Group>
        <p className="px-1 pt-2 text-callout text-ink-3">
          Deleting a document removes it from your vault. Older copies may remain in the provider&apos;s version history and in backups for a time.
          Everyone who can unlock the vault can read every document in it: people are for organising, not for privacy.
        </p>
      </Section>

      <Section>
        <GroupLabel>This device</GroupLabel>
        <Group>
          <KeyValueRow
            label="Saving to storage"
            value={state.sync?.problem ? `Problem: ${state.sync.problem}` : state.sync?.pending ? `${state.sync.pending} waiting` : "Up to date"}
          />
          {state.sync?.detail && <KeyValueRow label="Last failure" value={state.sync.detail} />}
          <KeyValueRow label="Signed in as" value={state.role === "admin" ? "Can manage the vault" : "Can add and edit"} />
          <KeyValueRow label="Documents" value={String(entries.length)} />
          <KeyValueRow label="Stored size (encrypted)" value={formatBytes(stored)} />
          <KeyValueRow label="Kept on this device" value={`${state.onDevice.length} · ${formatBytes(state.cacheBytes)}`} />
          <KeyValueRow
            label="Browser may clear the offline copy"
            value={persisted === null ? "Unknown" : persisted ? "No, storage is protected" : "Yes, if space runs low"}
          />
        </Group>
        <p className="px-1 pt-2 text-callout text-ink-3">
          The offline copy is ciphertext and is never the only copy. If the browser clears it, documents are fetched again when you&apos;re online.
        </p>
      </Section>
    </Screen>
  );
}
