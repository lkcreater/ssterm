# 05: Password prompt handoff

**What to build:** When an agent command hits a password or passphrase prompt, the agent pauses and the chat asks the user to type in the terminal. The user's input there never reaches the agent, and the command then continues and completes normally.

**Blocked by:** 03

**Status:** ready-for-agent (authorized 2026-10-23)

- [ ] Prompt patterns (`[sudo] password for`, `Password:`, `Enter passphrase`, …) pause the task and show a waiting card; focus moves to the pane.
- [ ] While paused, the user's keystrokes go to the pane (an exception to the input hold), and they are removed from the output returned to the agent.
- [ ] An undetected prompt times out and the agent receives only 'timed out waiting for input'.
- [ ] E2E with sudo on the fixture: the command completes and the password string never appears in any tool result, chat event, log or trace.
- [ ] Detect a password or passphrase prompt already showing in the pane **before** the ready probe is typed (ticket 02 probes before every command). Otherwise the probe line is submitted to the prompt and counts as one failed `sudo` authentication.

**Known limits of the ready probe (from ticket 02):** the probe line `printf '\033]ssterm;ready;<nonce>\007'` is typed into whatever program holds the terminal.

- At a `sudo` password prompt it is taken as a wrong password (one failed authentication).
- A stdin reader such as `cat > file` writes the probe text into the file.
- A nested POSIX shell (`ssh host2`, `sudo -i`) answers the probe, so the command then runs in that shell, not on the bound host.
