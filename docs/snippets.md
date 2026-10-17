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
