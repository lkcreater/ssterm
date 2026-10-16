/**
 * Copies text from a user gesture. `navigator.clipboard` is denied by the permission handler;
 * the Edit-menu copy path is not, so the text is supplied to one copy event and nothing else.
 */
export function copyText(text: string): boolean {
  const write = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    // A pane's own copy feedback must not report a terminal selection that was not copied.
    event.stopImmediatePropagation();
  };
  document.addEventListener("copy", write, { capture: true, once: true });
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", write, { capture: true });
  }
}
