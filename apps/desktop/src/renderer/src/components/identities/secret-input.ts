import { useCallback, useRef } from "react";
import { MAX_CREDENTIAL_BYTES, type DesktopAPI, type Result } from "@ssterm/contracts";

/**
 * An uncontrolled secret field: the value lives only in the DOM until `take` encodes and clears it.
 * Detaching or unmounting the field (React calls the ref with null) clears it too. Callers wipe taken bytes in `finally`.
 */
export function useSecretInput() {
  const element = useRef<HTMLInputElement | null>(null);
  const ref = useCallback((input: HTMLInputElement | null) => {
    if (!input && element.current) element.current.value = "";
    element.current = input;
  }, []);
  return {
    ref,
    filled: () => !!element.current?.value,
    /** Over the bridge limit? Measures a throwaway copy and wipes it. */
    tooLong() {
      const bytes = new TextEncoder().encode(element.current?.value ?? "");
      const over = bytes.byteLength > MAX_CREDENTIAL_BYTES;
      bytes.fill(0);
      return over;
    },
    take(): Uint8Array | null {
      const input = element.current;
      if (!input?.value) return null;
      const bytes = new TextEncoder().encode(input.value);
      input.value = "";
      return bytes;
    },
    clear() {
      if (element.current) element.current.value = "";
    },
    focus: () => element.current?.focus(),
  };
}
export type SecretInput = ReturnType<typeof useSecretInput>;

/** Shared secret field attributes: no autofill, spelling or capitalization help. */
export const secretFieldProps = {
  type: "password",
  autoComplete: "off",
  spellCheck: false,
  autoCapitalize: "none",
} as const;

const unavailable = {
  ok: false,
  error: { code: "unavailable", message: "The application is unavailable." },
} as const;
/** A bridge call that reports a missing bridge or a rejected IPC as `unavailable`. */
export async function call<T>(run: (bridge: DesktopAPI) => Promise<Result<T>>): Promise<Result<T>> {
  const bridge = window.ssterm;
  if (!bridge) return unavailable;
  try {
    return await run(bridge);
  } catch {
    return unavailable;
  }
}

/** Blocks a form submit (and Enter) while an IME composition is active. */
export const imeEnterGuard = (event: React.KeyboardEvent) => {
  if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
};

/** Copies non-secret text: navigator.clipboard is denied to this renderer, so a one-shot copy listener supplies the data. */
export function copyText(text: string): boolean {
  const supply = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
  };
  document.addEventListener("copy", supply);
  try {
    return document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", supply);
  }
}
