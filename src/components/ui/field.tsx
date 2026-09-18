"use client";

import { Search, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  useContext,
  useId,
  useState,
  type ChangeEvent,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { IconButton } from "./button";
import { cn } from "./cn";
import { Icon } from "./icon";

/* ---------- Field ---------- */

interface FieldContextValue {
  inputId: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps {
  /** Always above the field. Never a placeholder-as-label. */
  label: string;
  helper?: ReactNode;
  /** Says what to do, not what went wrong. Replaces the helper. */
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Label + control + helper/error. Inputs inside pick up id, aria-describedby and aria-invalid. */
export function Field({ label, helper, error, children, className }: FieldProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const noteId = `${id}-note`;
  const hasNote = Boolean(error || helper);

  return (
    <FieldContext.Provider value={{ inputId, describedBy: hasNote ? noteId : undefined, invalid: Boolean(error) }}>
      <div className={cn("flex min-w-0 flex-col gap-2", className)}>
        <label htmlFor={inputId} className="text-callout font-semibold text-ink-2">
          {label}
        </label>
        {children}
        {error ? (
          <p id={noteId} role="alert" className="flex items-start gap-1.5 text-callout text-danger">
            <Icon icon={TriangleAlert} className="mt-px size-4.5" />
            <span>{error}</span>
          </p>
        ) : (
          helper && (
            <p id={noteId} className="text-callout text-ink-3">
              {helper}
            </p>
          )
        )}
      </div>
    </FieldContext.Provider>
  );
}

/* ---------- inputs ---------- */

const shell =
  "flex min-h-13 items-center gap-2 rounded-md border bg-surface pr-1.5 pl-3.5 " +
  "transition-[border-color,box-shadow] duration-150 " +
  // shows on tap too, which is right: the keyboard just opened
  "focus-within:border-accent focus-within:shadow-[0_0_0_4px_var(--accent-soft)]";

const inputBase =
  "h-full min-h-12 w-full min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3";

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Overrides the Field's error state when used standalone. */
  invalid?: boolean;
  /** Rendered inside the field, after the input (a text action). */
  trailing?: ReactNode;
  inputClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

export function TextInput({ invalid, trailing, className, inputClassName, id, ref, ...rest }: TextInputProps) {
  const field = useContext(FieldContext);
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <div className={cn(shell, isInvalid ? "border-danger" : "border-control", className)}>
      <input
        ref={ref}
        id={id ?? field?.inputId}
        aria-describedby={field?.describedBy}
        aria-invalid={isInvalid || undefined}
        className={cn(inputBase, inputClassName)}
        {...rest}
      />
      {trailing}
    </div>
  );
}

const inFieldAction =
  "min-h-11 shrink-0 rounded-full px-2 text-label font-semibold text-accent " +
  "transition-opacity duration-150 hover:opacity-80 active:opacity-70 active:duration-0";

export type PasswordFieldProps = Omit<TextInputProps, "type" | "trailing">;

/** "Show" / "Hide" as words inside the field, not an eye icon. */
export function PasswordField({ autoComplete = "current-password", ...rest }: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <TextInput
      type={shown ? "text" : "password"}
      autoComplete={autoComplete}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      trailing={
        <button
          type="button"
          className={inFieldAction}
          aria-pressed={shown}
          aria-label={shown ? "Hide password" : "Show password"}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? "Hide" : "Show"}
        </button>
      }
      {...rest}
    />
  );
}

export interface MonoInputProps extends Omit<TextInputProps, "value" | "onChange" | "defaultValue"> {
  value: string;
  /** Receives the cleaned value: uppercased, no spaces. */
  onValueChange: (value: string) => void;
}

/** For recovery-code groups and document numbers. Auto-uppercases and ignores spaces. */
export function MonoInput({ value, onValueChange, maxLength, inputClassName, ...rest }: MonoInputProps) {
  const handle = (event: ChangeEvent<HTMLInputElement>) => {
    const clean = event.target.value.toUpperCase().replace(/\s+/g, "");
    onValueChange(maxLength ? clean.slice(0, maxLength) : clean);
  };
  return (
    <TextInput
      value={value}
      onChange={handle}
      autoCapitalize="characters"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      inputClassName={cn("font-mono font-medium uppercase tracking-[0.08em]", inputClassName)}
      {...rest}
    />
  );
}

/* ---------- SearchField ---------- */

const searchShell = "flex min-h-12 w-full items-center gap-2.5 rounded-full bg-sunken pl-4 text-body";

export type SearchFieldProps =
  | {
      /** A pill that looks like the field and opens the search screen. */
      mode: "button";
      placeholder?: string;
      href?: string;
      onClick?: () => void;
      className?: string;
    }
  | {
      mode?: "input";
      value: string;
      onValueChange: (value: string) => void;
      onSubmit?: (value: string) => void;
      placeholder?: string;
      autoFocus?: boolean;
      /** Accessible name; the placeholder is not a label. */
      "aria-label"?: string;
      className?: string;
      ref?: Ref<HTMLInputElement>;
    };

const DEFAULT_PLACEHOLDER = "Search documents, people, numbers";

export function SearchField(props: SearchFieldProps) {
  if (props.mode === "button") {
    const { placeholder = DEFAULT_PLACEHOLDER, href, onClick, className } = props;
    const classes = cn(
      searchShell,
      "pr-4 text-left text-ink-3 transition-colors duration-150 ease-out",
      "hover:bg-sunken-pressed active:bg-sunken-pressed active:duration-0",
      className,
    );
    const inner = (
      <>
        <Icon icon={Search} />
        <span className="truncate">{placeholder}</span>
      </>
    );
    return href ? (
      <Link href={href} className={classes} onClick={onClick}>
        {inner}
      </Link>
    ) : (
      <button type="button" className={classes} onClick={onClick}>
        {inner}
      </button>
    );
  }

  const {
    value,
    onValueChange,
    onSubmit,
    placeholder = DEFAULT_PLACEHOLDER,
    autoFocus,
    className,
    ref,
    "aria-label": ariaLabel = "Search documents",
  } = props;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit?.(value);
  };

  return (
    <form
      role="search"
      onSubmit={submit}
      className={cn(
        searchShell,
        "pr-0.5 text-ink transition-shadow duration-150 focus-within:shadow-[0_0_0_4px_var(--accent-soft)]",
        className,
      )}
    >
      <Icon icon={Search} className="size-5 text-ink-3" />
      <input
        ref={ref}
        type="search"
        enterKeyHint="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(inputBase, "[&::-webkit-search-cancel-button]:hidden")}
      />
      {value ? (
        <IconButton icon={X} variant="on-sunken" aria-label="Clear search" onClick={() => onValueChange("")} />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
    </form>
  );
}
