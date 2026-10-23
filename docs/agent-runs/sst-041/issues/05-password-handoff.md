# 05: Password prompt handoff

**What to build:** When an agent command hits a password or passphrase prompt, the agent pauses and the chat asks the user to type in the terminal. The user's input there never reaches the agent, and the command then continues and completes normally.

**Blocked by:** 03

**Status:** done

- [ ] Prompt patterns (`[sudo] password for`, `Password:`, `Enter passphrase`, …) pause the task and show a waiting card; focus moves to the pane.
- [ ] While paused, the user's keystrokes go to the pane (an exception to the input hold), and they are removed from the output returned to the agent.
- [ ] An undetected prompt times out and the agent receives only 'timed out waiting for input'.
- [ ] E2E with sudo on the fixture: the command completes and the password string never appears in any tool result, chat event, log or trace.
- [ ] Detect a password or passphrase prompt already showing in the pane **before** the ready probe is typed (ticket 02 probes before every command). Otherwise the probe line is submitted to the prompt and counts as one failed `sudo` authentication.

**Known limits of the ready probe (from ticket 02):** the probe line `printf '\033]ssterm;ready;<nonce>\007'` is typed into whatever program holds the terminal.

- At a `sudo` password prompt it is taken as a wrong password (one failed authentication).
- A stdin reader such as `cat > file` writes the probe text into the file.
- A nested POSIX shell (`ssh host2`, `sudo -i`) answers the probe, so the command then runs in that shell, not on the bound host.

**Implementation notes (2026-10-23, after review):**

- **Who gets a handoff.** Only a simple command, meaning one pipeline stage of plain words with no chaining, pipes, redirects, substitution, expansion, subshells or groups (the Read only tokenizer decides), whose first word is a reviewed prompting program: `sudo`, `su`, `ssh`, `scp`, `sftp`, `ssh-keygen`, `ssh-add`, `passwd`, `git`, or `docker login`. apt, dnf and yum prompt through sudo.
- **Everything else is stopped.** A prompt from any other command, or from any read-only step, gets Ctrl+C and the status `password-prompt-refused`; it is never handed off.
- **Read-only steps cannot read the terminal.** They run as `{ command; } </dev/null`.
- **Known gap: wrappers.** A wrapper under a listed program can still show a second prompt, for example `sudo sh -c '…'`, `su -c`, `ssh host 'cmd'`, git aliases or askpass helpers, or `SUDO_ASKPASS`. The card and banner warning that names the command ("Only type a password if you expected this prompt from <command>") is the real control there.
- **What the agent receives.** The user's input never reaches the agent. Output from the prompt to the next newline is not captured.
- **Withholding.** If later output contains a finished entry, the whole output is replaced by a fixed note, so the agent learns at most one bit per command. This covers the entry as typed, trimmed, or as base64 with or without a trailing newline or padding. `read_output` never matches an entry that is still being typed. Arbitrary transforms (split across lines, hashed, wrapped or re-encoded) cannot be recognised.
- **Zeroing is best effort.** Entry buffers, joined buffers, captured chunks and the line tracker's tail are zeroed in main. Decoded JS strings cannot be.
- **Line editing of an entry.** DEL and Ctrl+H both erase a character, Ctrl+W erases a word and Ctrl+U clears. Return (CR or a bare LF) ends the entry. Ctrl+C anywhere in a write interrupts the command, and the rest of a write after Return or Ctrl+C is dropped (`partly-held`).
- **E2E fixture.** The Docker fixture image has no sudo. The E2E installs a deterministic bash stand-in as `/usr/local/bin/sudo` in the owned container. It prints `[sudo] password for <user>: `, reads with `read -s`, allows three attempts, and with `--ssterm-echo-back` prints the entry back to exercise withholding.
