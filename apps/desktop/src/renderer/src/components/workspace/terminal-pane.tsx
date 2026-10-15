import {
  ConnectionStatus,
  type ConnectionState,
} from "@/components/connection/connection-status";
import {
  HostIdentity,
  type HostTarget,
} from "@/components/connection/host-identity";
import { Badge } from "@/components/ui/badge";
import {
  terminalAnsiKeys,
  terminalStyle,
  signalTerminalTheme,
} from "@/lib/terminal-theme";

export function TerminalPane({
  target,
  state,
  focused = false,
}: {
  target: HostTarget;
  state: ConnectionState;
  focused?: boolean;
}) {
  return (
    <section
      className="terminal-pane"
      data-focused={focused}
      aria-label={`Fixture terminal for ${target.name}`}
      style={terminalStyle}
    >
      <div className="terminal-context">
        <HostIdentity target={target} copy />
        <ConnectionStatus state={state} />
        <Badge variant="fixture">Fixture output</Badge>
      </div>
      <pre
        className="terminal-output"
        aria-label="Static terminal output, no live connection"
      >
        <span style={{ color: signalTerminalTheme.green }}>
          {target.user}@{target.name}
        </span>
        {":~$ pwd\n/home/deploy\n"}
        <span style={{ color: signalTerminalTheme.cyan }}>
          สวัสดี · connected with clarity
        </span>
        {"\n"}
        {terminalAnsiKeys.map((key, index) => (
          <span key={key} style={{ color: signalTerminalTheme[key] }}>
            {index === 8 ? "\n" : ""}
            {"██ "}
          </span>
        ))}
        {"\n\n"}
        {state === "error"
          ? "Connection lost. History is preserved in this fixture."
          : "Static preview · no commands are sent."}
      </pre>
    </section>
  );
}
