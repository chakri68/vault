"use client";

import { KeyRound, NotebookPen, Users } from "lucide-react";
import { Button, Group, Row, TopBar } from "@/components/ui";
import { AuthHeading, AuthScreen } from "./auth-screen";

/**
 * A quiet way out of the lock screen. It explains the recovery code rather than
 * asking for it: the code is two taps away, not a field next to the password.
 */
export function CantGetIn({ onBack, onUseCode }: { onBack: () => void; onUseCode: () => void }) {
  return (
    <AuthScreen
      bar={<TopBar backLabel="Back" onBack={onBack} />}
      actions={<Button variant="secondary" size="lg" icon={NotebookPen} onClick={onUseCode}>Use the recovery code</Button>}
    >
      <AuthHeading title="Can't get in?">
        <p>Try these, in this order.</p>
      </AuthHeading>
      <Group>
        <Row
          icon={KeyRound}
          label="Try the family password again"
          description="It's the same one for everyone. Check caps lock, and type it slowly with Show turned on."
        />
        <Row
          icon={Users}
          label="Ask someone else in the family"
          description="They can tell you the password. If their phone still opens the vault, they can also help you set a new one."
        />
        <Row
          icon={NotebookPen}
          label="Use the recovery code"
          description="The 8 groups of letters and numbers written down when the vault was set up. It's probably with the passports. This is the last resort."
        />
      </Group>
      <p className="max-w-[65ch] px-1 text-callout text-ink-3">
        Without the password, a phone that still opens the vault, or the recovery code, nobody can open it. Not whoever runs this site, not anyone.
      </p>
    </AuthScreen>
  );
}
