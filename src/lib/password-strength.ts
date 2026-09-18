/**
 * Family password strength (§4.3). An estimator, not character-class rules: a
 * weak family password is the practical break in this design, and "P@ssw0rd1"
 * passes every rule ever written.
 *
 * zxcvbn and its dictionaries are a few hundred KB, and only setup and "new
 * password" need them, so they load on demand. They're bundled first-party:
 * nothing about the password goes anywhere.
 */

export type StrengthLevel = 0 | 1 | 2 | 3;

export interface Strength {
  /** 0–3: how many steps past the first bar are filled */
  level: StrengthLevel;
  /** always shown beside the bar: never colour alone */
  label: "Too easy to guess" | "Could be stronger" | "Good" | "Strong";
  /** the floor for a family password */
  acceptable: boolean;
}

export const STRENGTH_STEPS = 4;

// Words the screen itself suggests, plus the obvious ones. Typing the example back isn't a password.
const PENALISED = ["mango", "tree", "monsoon", "kettle", "family", "vault", "familyvault", "password"];

type Checker = (password: string) => number;

let checker: Promise<Checker> | null = null;

function load(): Promise<Checker> {
  checker ??= (async () => {
    const [{ ZxcvbnFactory }, common] = await Promise.all([
      import("@zxcvbn-ts/core"),
      import("@zxcvbn-ts/language-common"),
    ]);
    const zxcvbn = new ZxcvbnFactory({ dictionary: common.dictionary, graphs: common.adjacencyGraphs });
    return (password: string) => zxcvbn.check(password, PENALISED).score;
  })();
  // a failed chunk load shouldn't stick forever
  checker.catch(() => { checker = null; });
  return checker;
}

/** Start fetching the estimator before the first keystroke needs it. */
export function preloadStrength(): void {
  void load().catch(() => {});
}

export function describeScore(score: number): Strength {
  if (score >= 4) return { level: 3, label: "Strong", acceptable: true };
  if (score === 3) return { level: 2, label: "Good", acceptable: true };
  if (score === 2) return { level: 1, label: "Could be stronger", acceptable: false };
  return { level: 0, label: "Too easy to guess", acceptable: false };
}

export async function measureStrength(password: string): Promise<Strength> {
  if (!password) return describeScore(0);
  // the estimator's cost grows with length; past this it only ever says "strong"
  const check = await load();
  return describeScore(check(password.slice(0, 128)));
}
