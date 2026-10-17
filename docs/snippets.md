# Snippets — SST-023

**2026-10-17 · T029 · DONE through independent TEST/REVIEW/DELIVER.** Local snippet persistence and CRUD. This is proposed ssterm behavior, independently implemented; Termius observations are contextual only. See [ticket](termius/tickets.md#sst-023--snippet-persistence--crud), [execution plan](agent-runs/implementation-plan.md#sst-023-execution-plan--2026-10-17) and [delivery](agent-runs/sst-023-delivery.md) records. Paste/Run on a session is SST-024.

## Behavior

- **Snippets page** in the sidebar: a searchable list and an editor with name, script body (monospace, no wrapping, scrolls), tag toggles and a New tag field. Save (button or ⌘S), Revert, Close, and Delete with a confirmation whose Cancel is focused. Leaving an unsaved editor asks first. The page stays mounted, so a draft survives switching pages.
- **Saving never runs anything.** No session is opened and no bytes are sent; the page says so.
- **Search** matches every term against names and tag names (NFC, case-insensitive). Bodies are never searched or indexed.
- **Validation**: name 1–200 characters without control characters; body at most 1 MiB of UTF-8 and no lone surrogates; tags must exist. Problems appear on the field; main repeats every check and returns typed field errors.
- **Empty bodies** save as an encrypted empty envelope.

## Protection and storage

- Bodies are sealed by `SecretService` with the vault content key (`aes-256-gcm-v1`, SST-006) bound to vault, snippet and field. SQLite holds only the envelope; the E2E and unit tests scan the database and WAL for fixture plaintext.
- The **first save** on a vault without a key creates the key once in the Keychain. An existing key is never replaced; a missing or denied key is reported and the stored ciphertext is left untouched. Deleting snippets needs no key.
- Tag membership is written in the same revision-fenced commit as the body. Delete removes the snippet and its memberships; tags and the vault key remain.
- **IPC**: `openSnippet`, `saveSnippet`, `deleteSnippet` (`packages/contracts/src/snippets.ts`), owner/sender-authorized, exact-key guards. Plaintext crosses only as the open response and the save request. Catalog state carries `{id, revision, label, tagIds}` and a `lockEpoch` counter, never bodies, envelopes or key references.

## Lock

The explicit action is the unlock (identities rule). An open, save or delete that started before a later lock returns no plaintext and commits nothing: main fences the commit synchronously. On a lock, main republishes catalog state with a higher `lockEpoch`; the renderer closes the editor, discards the draft and offers *Open again*.

## Verification

`npm run typecheck`, `npm test` (406), `npm run build`, `npm run test:e2e` (56, including `snippets.spec.ts`), `npm run package:mac`, `npm run test:packaged` (53). The E2E relaunches on the same profile and Keychain namespace (`close({ keepSecrets: true })`) to prove bodies decrypt byte-for-byte after restart, then empties the namespace. Rendered contrast ≥ 4.5:1 at 960×640 for body, status, notice and row.

## Limitations

- The textarea normalizes CR/CRLF to LF; bodies entered through the editor are stored as LF.
- Deleting a tag elsewhere bumps the snippet's revision, so an open editor's next save reports a conflict; the draft stays visible for copying, but there is no merge.
- The renderer learns a lock through pushed catalog state; an open that unlocks before that push arrives is then shown as locked (safe, may need one more *Open again*).
- Labels with lone surrogates are not rejected (shared catalog label rule).
- A lost Keychain key makes existing bodies unrecoverable by design. After the first snippet, SST-006's migration refusal for protected vaults applies to future schema changes.

# Snippet Paste / Run — SST-024

**2026-10-17 · T030 · DONE through independent TEST/REVIEW/DELIVER.** [Execution plan](agent-runs/implementation-plan.md#sst-024-execution-plan--2026-10-17), [delivery](agent-runs/sst-024-delivery.md). Renderer-only: bodies come from the SST-023 `openSnippet` decrypt for each explicit action, and bytes go through the existing `writeTerminal` fence (owner, session, generation, Ready).

## Behavior

- **Snippets panel** floats over the terminal workspace (no PTY resize). Open it with ⇧⌘S or a pane's menu (*Snippets…*, which makes that pane active); ⇧⌘S while open returns to its search; Esc (after clearing a filled search) or Close shuts it. It shows the live **active terminal** (state, label, PROD, endpoint), a name/tag search and per-snippet **Paste** and **Run**.
- **Paste** decrypts into an editable **Pending input** composer and sends nothing. The composer names the session that was active at Paste and sends only there (“This is not the active terminal” when focus moved). Its **Run** and **Insert without Enter** are the only ways its text leaves; Discard drops it.
- **Run** from the list captures the active Ready session at the click; switching panes while the body decrypts cannot redirect it. With no connected active terminal: “No connected terminal is active. Nothing was sent.”
- **Bytes** (`lib/snippet-dispatch.ts`): sanitized like clipboard paste (C0 except HT/LF/CR, DEL, C1, bidi removed, so an embedded `ESC[201~` cannot end a bracket); CRLF/LF/CR become CR; wrapped in `ESC[200~…ESC[201~` when the shell has bracketed paste on. Insert sends the text only; Run drops one trailing line break and adds exactly one CR. Empty → nothing sent; over 256 KiB → refused. One snippet is one write, queued in the pane's own ordered input queue behind typing and fenced to the captured generation.
- **Confirmation** (Cancel focused, target and line count shown) before Run on PROD, when characters were removed, or when multiline text would run line by line (bracketed paste off). Confirming re-plans against the shell's current mode and asks again if a new reason appeared.
- **Feedback**: “Sent and pressed Enter: N lines to <target>. ssterm cannot tell whether the command succeeded.” A refused write says nothing more was sent (and pauses the pane like typing).
- **Lock**: the composer's decrypted text and any pending confirmation are cleared; a decrypt resolving after the lock is discarded.

## Verification

`tests/unit/snippet-dispatch.test.ts`, shortcut tests, and `tests/e2e/snippet-run.spec.ts` on the Docker OpenSSH fixture with main-recorded writes: zero writes on Paste and composer edits; cancelled PROD Run sends nothing; Run = one write and executes; Insert waits until Enter; empty snippet sends nothing; multiline Thai on a DEV session in one bracketed paste; a gated decrypt while switching from the DEV to the PROD pane delivers only to DEV; no-active-terminal error; lock clears the composer; contrast ≥ 4.5:1 at 960×640. Full suite: 410 unit / 57 development / 54 packaged.

## Limitations

- The panel overlays the right side of the workspace and can cover the rightmost pane's header (status, menu, close) while open; the panel shows its own target, and Esc/Close are always reachable.
- “Sent” means main accepted the write for that session generation; delivery to the remote shell and command success are not observed.
- The E2E's decrypt gate relies on Electron's private `ipcMain._invokeHandlers` and asserts that the gate was active.
