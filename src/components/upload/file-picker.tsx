"use client";

import { useCallback, useRef, type ReactNode } from "react";

export interface FilePickerOptions {
  /** what the hidden input is for, for assistive tech and tests */
  label: string;
  accept?: string;
  multiple?: boolean;
  /** "environment" opens the rear camera directly on phones */
  capture?: "environment" | "user";
  onFiles: (files: File[]) => void;
}

/**
 * The OS file picker behind a row or a button. The input itself is never shown:
 * what people tap is a labelled row, and the input is just how a web page asks
 * the OS for a file.
 */
export function useFilePicker({ label, accept, multiple, capture, onFiles }: FilePickerOptions): { input: ReactNode; open: () => void } {
  const ref = useRef<HTMLInputElement>(null);
  const open = useCallback(() => ref.current?.click(), []);
  const input = (
    <input
      ref={ref}
      type="file"
      hidden
      tabIndex={-1}
      aria-label={label}
      data-picker={label}
      accept={accept}
      multiple={multiple}
      capture={capture}
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = ""; // so choosing the same file twice still fires
        if (files.length) onFiles(files);
      }}
    />
  );
  return { input, open };
}
