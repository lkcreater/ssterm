# SST-013 — Terminal input, Unicode and clipboard

**2026-10-16 · T019 · DONE through independent TEST/REVIEW/DELIVER; committed under the standing loop instruction.** Authorized by the standing loop instruction after SST-012 commit `dba21d4`. Scope is typing, IME, Unicode widths, copy, paste, search, link opening and shortcut routing in the terminal pane. Snippet Paste/Run (SST-024), large-paste throughput (SST-014), persisted terminal settings and pane navigation (SST-018) are separate. [Execution plan](agent-runs/implementation-plan.md#sst-013-execution-plan--2026-10-16).

## Typing, IME and Unicode

Each stacked pane keeps its own session identity, so only the pane that has DOM focus receives keystrokes, IME commits or pastes. xterm sends Thai layout keydowns and `insertText` once, and commits IME composition once at `compositionend`; the composition view uses the terminal colors. Widths follow Unicode 11 (`@xterm/addon-unicode11`), which matches glibc for Thai combining marks, CJK, emoji and ZWJ sequences; xterm's default Unicode 6 counted emoji as one cell. The shell requests the IUTF8 PTY mode so the remote line discipline erases whole UTF-8 characters. ssterm sends no `LANG`; a remote shell without a UTF-8 locale still mishandles typed Thai (bash/readline treats the bytes as Meta keys), which is the remote host's configuration. Option stays a third-level shift (`macOptionIsMeta` false until SST-018 settings), and Option+click forces selection.

## Copy and paste

Copy and paste use the macOS Edit menu roles (Cmd+C/Cmd+V), which fire DOM clipboard events on the focused terminal; `navigator.clipboard` stays denied and OSC 52 clipboard access is not loaded. Copy shows a pane status with the character count; there is no copy-on-select.

Paste is intercepted before xterm in the focused pane. The text is sanitized: C0 controls except tab, newline and carriage return, DEL and C1 controls are removed, which blocks an embedded `ESC[201~` from escaping bracketed paste. Pastes over 256 KiB are refused. A multiline paste needs confirmation when the shell is not in bracketed paste mode, when the target is PROD, or when anything was removed; the dialog shows the captured target, PROD label, line count and a plain-text preview, with Cancel focused by default. Otherwise the text is pasted (bracketed when the shell asked for it) with a “Pasted N lines into …” status. No Enter is ever added.

## Links, search and shortcuts

Plain URLs (`@xterm/addon-web-links`) and OSC 8 hyperlinks open only on Cmd+click. The renderer sends `openLink({owner, url})`; main authorizes the sender and owner, accepts only http/https without embedded credentials and at most 2,048 characters, shows a native confirmation with the exact URL (Cancel default) and only then calls `shell.openExternal`. A plain click does nothing.

Cmd+F opens a search bar for the focused pane (`@xterm/addon-search`) with match decorations and an “n of m” count; Enter and Shift+Enter move between matches and Esc closes it and returns focus to the terminal. Search input never reaches the remote. Only Cmd+F and, since SST-034, Cmd+; ([command-history suggestions](recording.md), matched by the physical Semicolon key under non-Latin layouts) are intercepted from the terminal; Tab, Ctrl and Option combinations go to the shell. The explicit application menu keeps Edit, zoom and fullscreen; reload and DevTools exist only in development builds, because a reload rotates the window owner and closes every session.

## Verification

Final source: `npm run typecheck` PASS, `npm test` **190/190**, `npm run build` PASS, `npm run test:e2e` **21/21**, `npm run package:mac` PASS (unsigned arm64), `npm run test:packaged` **18/18**; the input spec also passed 6/6 repeated runs after a test-helper fix.

[Unit tests](../tests/unit/terminal-input.test.ts) cover the sanitizer (C0/DEL/C1, bidi controls, ZWJ/VS16 preserved), paste decisions by UTF-8 size, bracketed mode, PROD and removal, Cmd+F under Latin, Thai and Russian layouts, Cmd-only link activation and search-decoration contrast (foreground 14.3:1, every ANSI color ≥ 4.59:1). [Menu](../tests/unit/menu.test.ts) and [link](../tests/unit/links.test.ts) tests cover packaged versus development menus and URL validation/handler authorization; a loopback test checks the IUTF8 PTY mode bytes.

[Runtime E2E](../tests/e2e/terminal-input.spec.ts) runs against Docker OpenSSH through the shipped adapter, controller, handlers and pane: UTF-8 charmap and `iutf8`; Thai typed bytes exact and Backspace removing one whole Thai character; CDP IME composition delivered once; cursor width equal to glibc `wc -L` for Thai, CJK, emoji and ZWJ; PROD multiline confirmation with Cancel sending nothing and Paste leaving lines unexecuted until Enter; `ESC[201~` injection stripped; oversize refusal; copy of a mouse selection; plain click versus Cmd+click on plain and OSC 8 links recorded by a fake opener, `javascript:` and stale owners refused; per-pane search with count and Esc that sends nothing; two stacked panes receiving only their own input. The independent tester also verified the packaged runtime menu (no reload/DevTools), the shipped native link confirmation with stubbed dialog/opener, non-bracketed confirmation and dialog behavior on close and reconnect.

Review found no critical/high/medium issues; all low findings were fixed: re-confirmation when bracketed mode turns off while the dialog is open, Cmd+F by key code under non-Latin layouts, bidi-control removal with a wrapping scroll preview and tab/newline markers, stale search results after closing, active-match contrast, `devTools` disabled when packaged, a distinct over-length link message and closing the dialog when the session stops accepting input. An interrupted large paste can leave the remote inside bracketed paste; that belongs to SST-014.

## Boundaries and rollback

Physical Thai Kedmanee/Pattachote layouts, Japanese IME, the emoji picker, dictation and real Cmd+C/Cmd+V through the menu remain a manual matrix; automated tests use CDP input and synthetic clipboard events so they never touch the real pasteboard. A credential prompt that opens while typing still takes focus (SST-011 behavior). Rollback removes the menu, link IPC, input policy and the three addon pins and the IUTF8 mode; there is no data change.
