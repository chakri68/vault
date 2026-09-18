"use client";

import {
  Camera,
  CircleCheck,
  Clock,
  CloudOff,
  Download,
  FileText,
  FileUp,
  HardDrive,
  Images,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Printer,
  Smartphone,
  Trash2,
  TriangleAlert,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  AppMark,
  Availability,
  Avatar,
  Banner,
  BottomBar,
  Button,
  CATEGORIES,
  CategoryGrid,
  CategoryTile,
  Chip,
  ChipRow,
  ConfirmDialog,
  DEFAULT_CATEGORY_IDS,
  EmptyState,
  Field,
  Group,
  GroupLabel,
  Icon,
  IconButton,
  KeyValueRow,
  MetaPill,
  MonoInput,
  PasswordField,
  ProgressBar,
  RecoveryCodeGrid,
  Row,
  Screen,
  ScreenHeader,
  SearchField,
  Section,
  SegmentedControl,
  Sheet,
  SkeletonRows,
  StatusPill,
  StepProgress,
  TextInput,
  Tile,
  ToastProvider,
  TopBar,
  useToast,
} from "@/components/ui";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section>
      <GroupLabel>{title}</GroupLabel>
      <div className="flex flex-col gap-3">{children}</div>
    </Section>
  );
}

function Stage({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 rounded-lg border border-line p-4">{children}</div>;
}

const RECOVERY = ["K7QM", "4X2P", "9WBN", "T3RV", "8HFD", "2NAC", "6JYE", "5MSZ"];

function GalleryBody() {
  const { toast } = useToast();
  const [person, setPerson] = useState("all");
  const [tags, setTags] = useState<string[]>(["tax"]);
  const [retention, setRetention] = useState<"7" | "30" | "90" | "never">("30");
  const [view, setView] = useState<"grid" | "list">("list");
  const [offline, setOffline] = useState(true);
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [shredOpen, setShredOpen] = useState(false);
  const [query, setQuery] = useState("pan card");
  const [name, setName] = useState("Health insurance policy — 2026");
  const [g3, setG3] = useState("9WBN");
  const [g7, setG7] = useState("");
  const [numberShown, setNumberShown] = useState(false);

  const people = [
    { id: "mom", name: "Mom", cat: "photos" as const },
    { id: "dad", name: "Dad", cat: "identity" as const },
    { id: "chakri", name: "Chakri", cat: "finance" as const },
  ];

  return (
    <>
      <Screen bottomBar gap="lg">
        <TopBar backLabel="Documents" onBack={() => toast({ message: "Back pressed" })} action={<Button variant="text">Edit</Button>} />
        <ScreenHeader
          title="Almirah primitives"
          trailing={
            <Button variant="secondary" size="sm" icon={Lock}>
              Lock
            </Button>
          }
        >
          Every component in every variant. Tab through it, press things, flip the OS theme, bump the text size to 200%.
        </ScreenHeader>

        <Block title="App mark, step progress">
          <div className="flex items-center gap-4">
            <AppMark />
            <AppMark size={40} />
          </div>
          <TopBar backLabel="Back" onBack={() => {}} trailing="Step 4 of 6" />
          <StepProgress current={4} />
        </Block>

        <Block title="Buttons">
          <Stage>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button icon={Plus}>Add document</Button>
              <Button variant="secondary" icon={Download}>
                Download
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button variant="secondary" size="sm">
                Change
              </Button>
              <Button variant="text">See all</Button>
              <Button variant="text" size="sm">
                Show
              </Button>
              <Button variant="danger" size="sm">
                Delete permanently
              </Button>
              <Button variant="danger-text">Move to trash</Button>
            </div>
            <Button
              size="lg"
              loading={saving}
              loadingLabel="Saving…"
              onClick={() => {
                setSaving(true);
                setTimeout(() => setSaving(false), 2500);
              }}
            >
              Save to vault
            </Button>
            <Button variant="secondary" size="lg">
              Unlock with password
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled>Disabled (Shred only)</Button>
              <IconButton icon={Plus} aria-label="Filled icon button" />
              <IconButton icon={Plus} variant="plain" aria-label="Plain icon button" />
            </div>
          </Stage>
        </Block>

        <Block title="Rows: the workhorse">
          <Group>
            <Row
              icon={Smartphone}
              label="Keep everything offline"
              description="Uses 184 MB on this phone"
              checked={offline}
              onCheckedChange={setOffline}
            />
            <Row icon={Lock} label="Lock after" value="5 minutes" onClick={() => {}} />
            <Row icon={HardDrive} label="Backups" description="2 copies · checked today" href="/dev/ui" />
            <Row
              icon={HardDrive}
              label="Backups"
              trailing={
                <StatusPill tone="good" icon={CircleCheck}>
                  Healthy
                </StatusPill>
              }
              onClick={() => {}}
            />
            <Row
              icon={KeyRound}
              label="Recovery code"
              chevron={false}
              trailing={<span className="text-label font-semibold text-accent">View</span>}
              onClick={() => {}}
            />
            <Row icon={Users} label="A static row with a long label that has to wrap onto a second line at some point" />
          </Group>

          <GroupLabel action={<Button variant="text" size="sm">See all</Button>}>Expiring soon</GroupLabel>
          <Group>
            <Row
              truncate
              leading={<Tile cat="insurance" icon={CATEGORIES.insurance.icon} />}
              label="Car insurance"
              description="Insurance · Dad"
              chevron={false}
              trailing={
                <StatusPill tone="warn" icon={Clock}>
                  21 days
                </StatusPill>
              }
              onClick={() => {}}
            />
            <Row
              truncate
              leading={<Tile cat="travel" icon={CATEGORIES.travel.icon} />}
              label="Visa — Dad, with a very long name that should end in an ellipsis"
              description="Travel · Dad"
              onClick={() => {}}
            />
            <Row leading={<Avatar name="Mom" cat="photos" size={40} />} label="Mom" description="12 documents" onClick={() => {}} />
          </Group>

          <Group>
            <Row danger icon={Trash2} label="Move to trash" onClick={() => toast({ message: "Moved Aadhaar — Chakri to trash", action: { label: "Undo", onAction: () => {} } })} />
          </Group>
        </Block>

        <Block title="Details list">
          <Group>
            <KeyValueRow
              label="Passport no."
              mono
              value={numberShown ? "Z1234567" : "Z12•••••"}
              action={
                <Button variant="text" size="sm" onClick={() => setNumberShown((s) => !s)}>
                  {numberShown ? "Hide" : "Show"}
                </Button>
              }
            />
            <KeyValueRow label="Expires" value="12 Mar 2031" hint="in 4 yrs" />
            <KeyValueRow label="Issued by" value="RPO Hyderabad" />
            <KeyValueRow label="Availability" value={<Availability onDevice className="text-label text-ink" />} />
          </Group>
          <div className="flex flex-wrap gap-2">
            <MetaPill leading={<span data-cat="identity" className="text-(--cat-fg)"><Icon icon={CATEGORIES.identity.icon} className="size-[0.9375rem]" /></span>}>Identity</MetaPill>
            <MetaPill leading={<Avatar name="Mom" cat="photos" />}>Mom</MetaPill>
          </div>
        </Block>

        <Block title="Fields">
          <Stage>
            <Field label="Document name" helper="Shown in your list and in search.">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Family password" error="Too easy to guess. Try four unrelated words, like “mango tree monsoon kettle”.">
              <PasswordField defaultValue="family123" autoComplete="off" />
            </Field>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Group 3">
                <MonoInput value={g3} onValueChange={setG3} maxLength={4} />
              </Field>
              <Field label="Group 7" error={g7.length === 4 && g7 !== "6JYE" ? "That doesn’t match group 7. Check what you wrote." : undefined}>
                <MonoInput value={g7} onValueChange={setG7} maxLength={4} placeholder="····" />
              </Field>
            </div>
            <SearchField mode="button" onClick={() => toast({ message: "Would open Search" })} />
            <SearchField value={query} onValueChange={setQuery} />
          </Stage>
        </Block>

        <Block title="Chips, segmented">
          <ChipRow aria-label="Whose documents">
            <Chip selected={person === "all"} onClick={() => setPerson("all")}>
              All
            </Chip>
            {people.map((p) => (
              <Chip key={p.id} selected={person === p.id} onClick={() => setPerson(p.id)} avatar={<Avatar name={p.name} cat={p.cat} />}>
                {p.name}
              </Chip>
            ))}
          </ChipRow>
          <ChipRow aria-label="Tags" overflow="wrap">
            {["tax", "2026", "originals", "renewal"].map((t) => (
              <Chip key={t} selected={tags.includes(t)} onClick={() => setTags((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]))}>
                {t}
              </Chip>
            ))}
          </ChipRow>
          <SegmentedControl
            aria-label="Keep trash for"
            value={retention}
            onValueChange={setRetention}
            options={[
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
              { value: "never", label: "Never" },
            ]}
          />
          <SegmentedControl
            aria-label="View"
            fullWidth
            value={view}
            onValueChange={setView}
            options={[
              { value: "grid", label: "Until I delete it" },
              { value: "list", label: "Temporarily" },
            ]}
          />
        </Block>

        <Block title="Banners">
          <Banner
            title="Only one phone can open this vault"
            action={{ label: "Add another phone", onClick: () => {} }}
            secondaryAction={{ label: "View recovery code", onClick: () => {} }}
          >
            If this phone is lost, you’ll need the recovery code.
          </Banner>
          <Banner tone="info" icon={CloudOff} title="You’re offline">
            Documents on this phone still open. Changes will save when you’re back online.
          </Banner>
          <Banner tone="danger" title="Google Drive backup didn’t complete" action={{ label: "Retry now", onClick: () => {} }}>
            Your document is saved. We’ll keep trying.
          </Banner>
        </Block>

        <Block title="Status, progress, skeleton">
          <div className="flex flex-wrap gap-2.5">
            <StatusPill tone="good" icon={CircleCheck}>
              Healthy · 2 min ago
            </StatusPill>
            <StatusPill tone="warn" icon={Clock}>
              Stale · 32 days ago
            </StatusPill>
            <StatusPill tone="danger" icon={TriangleAlert}>
              Failed · Retry
            </StatusPill>
            <StatusPill tone="neutral" icon={CloudOff}>
              Disconnected
            </StatusPill>
          </div>
          <div className="flex flex-wrap gap-5">
            <Availability onDevice />
            <Availability onDevice={false} />
          </div>
          <ProgressBar label="Encrypting on your phone…" value={72} />
          <ProgressBar label="Checking everything works…" />
          <SkeletonRows count={2} />
        </Block>

        <Block title="Toasts, sheets, dialogs">
          <div className="flex flex-wrap gap-2.5">
            <Button variant="secondary" onClick={() => toast({ message: "Saved to your vault" })}>
              Toast
            </Button>
            <Button
              variant="secondary"
              icon={Trash2}
              onClick={() => toast({ message: "Moved Aadhaar — Chakri to trash", action: { label: "Undo", onAction: () => toast({ message: "Restored Aadhaar — Chakri" }) } })}
            >
              Toast with Undo
            </Button>
            <Button variant="secondary" onClick={() => setMoreOpen(true)}>
              More sheet
            </Button>
            <Button variant="secondary" onClick={() => setAddOpen(true)}>
              Add sheet
            </Button>
            <Button variant="secondary" onClick={() => setConfirmOpen(true)}>
              Confirm dialog
            </Button>
            <Button variant="secondary" onClick={() => setShredOpen(true)}>
              Confirm with checkbox
            </Button>
          </div>
        </Block>

        <Block title="Categories">
          <CategoryGrid>
            {DEFAULT_CATEGORY_IDS.map((id, i) => (
              <CategoryTile key={id} cat={CATEGORIES[id].cat} icon={CATEGORIES[id].icon} name={CATEGORIES[id].label} count={i === 3 ? 1 : (i * 5) % 16} onClick={() => {}} />
            ))}
          </CategoryGrid>
          <div className="flex flex-wrap items-center gap-3">
            <Avatar name="Mom" cat="photos" />
            <Avatar name="Dad" cat="identity" size={32} />
            <Avatar name="Chakri" cat="finance" size={40} />
            <Avatar name="Ammamma" emoji="🌼" cat="property" size={40} />
          </div>
        </Block>

        <Block title="Recovery code">
          <RecoveryCodeGrid groups={RECOVERY} />
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="secondary" icon={Printer}>
              Print
            </Button>
            <Button variant="secondary" icon={Download}>
              Save
            </Button>
          </div>
        </Block>

        <Block title="Empty state">
          <Stage>
            <EmptyState
              cat="insurance"
              icon={CATEGORIES.insurance.icon}
              message="No insurance documents yet."
              action={
                <Button size="sm" icon={Plus}>
                  Add document
                </Button>
              }
            />
          </Stage>
        </Block>
      </Screen>

      <BottomBar active="documents" onAdd={() => setAddOpen(true)} documentsHref="/dev/ui" settingsHref="/dev/ui" />

      <Sheet open={moreOpen} onOpenChange={setMoreOpen} title="Passport — Mom" description="More actions for this document">
        <Group>
          <Row icon={Pencil} label="Rename" chevron={false} onClick={() => setMoreOpen(false)} />
          <Row icon={FileText} label="Edit details" chevron={false} onClick={() => setMoreOpen(false)} />
          <Row icon={FileUp} label="Replace file" chevron={false} onClick={() => setMoreOpen(false)} />
          <Row icon={Smartphone} label="Keep on this device" description="Opens without internet" checked={pinned} onCheckedChange={setPinned} />
        </Group>
        <Group>
          <Row
            danger
            icon={Trash2}
            label="Move to trash"
            onClick={() => {
              setMoreOpen(false);
              toast({ message: "Moved Passport — Mom to trash", action: { label: "Undo", onAction: () => {} } });
            }}
          />
        </Group>
      </Sheet>

      <Sheet open={addOpen} onOpenChange={setAddOpen} title="Add a document">
        <Group>
          <Row leading={<Tile icon={Camera} />} label="Take a photo" description="Best for cards and single pages" chevron={false} onClick={() => setAddOpen(false)} />
          <Row leading={<Tile icon={Images} />} label="Choose from photos" chevron={false} onClick={() => setAddOpen(false)} />
          <Row leading={<Tile icon={FileUp} />} label="Choose a file" description="PDFs, scans, anything saved" chevron={false} onClick={() => setAddOpen(false)} />
        </Group>
      </Sheet>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete Passport — Mom permanently?"
        body="It will be removed from your vault. Older copies may remain in version history and in backups for a time."
        confirmLabel="Delete permanently"
        onConfirm={() => {
          setConfirmOpen(false);
          toast({ message: "Deleted Passport — Mom permanently" });
        }}
      />
      <ConfirmDialog
        open={shredOpen}
        onOpenChange={setShredOpen}
        title="Remove Dad’s old phone?"
        body="That phone won’t be able to unlock the vault again. Documents it already opened may have been copied while it had access."
        confirmLabel="Remove device"
        requireAcknowledge="I understand this can’t be undone"
        onConfirm={() => setShredOpen(false)}
      />
    </>
  );
}

export function Gallery() {
  return (
    <ToastProvider>
      <GalleryBody />
    </ToastProvider>
  );
}
