# 05: Password prompt handoff

**What to build:** When an agent command hits a password or passphrase prompt, the agent pauses and the chat asks the user to type in the terminal. The user's input there never reaches the agent, and the command then continues and completes normally.

**Blocked by:** 03

**Status:** ready-for-agent (implementation not yet authorized: A13)

- [ ] Prompt patterns (`[sudo] password for`, `Password:`, `Enter passphrase`, …) pause the task and show a waiting card; focus moves to the pane.
- [ ] While paused, the user's keystrokes go to the pane (an exception to the input hold), and they are removed from the output returned to the agent.
- [ ] An undetected prompt times out and the agent receives only 'timed out waiting for input'.
- [ ] E2E with sudo on the fixture: the command completes and the password string never appears in any tool result, chat event, log or trace.
