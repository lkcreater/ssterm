import type { HostTarget } from "@/components/connection/host-identity";
import { FileTransferRecipe } from "@/components/recipes/file-transfer";
import {
  CredentialRecipe,
  TunnelRecipe,
} from "@/components/recipes/tunnels-credentials";
import { TerminalPane } from "@/components/workspace/terminal-pane";
import { SnippetComposer } from "@/components/workspace/snippet-composer";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Section } from "./section";

export const fixtureTarget: HostTarget = {
  name: "prod-api-01",
  user: "deploy",
  host: "production-api-with-a-very-long-hostname.lab.ssterm.invalid",
  port: 22,
  production: true,
};
export function Recipes() {
  return (
    <Section
      id="recipes"
      title="Integrated recipes · fixtures"
      description="Deterministic composition previews for later services. Connected labels, output, progress and failures are fixture states. SSH, SFTP, secret storage and tunnels are unavailable."
    >
      <Card>
        <CardHeader>
          <CardTitle>Terminal workspace</CardTitle>
          <CardDescription>
            Focused pane, explicit target and PROD risk remain legible
            independently of connection state.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <TerminalPane target={fixtureTarget} state="connected" focused />
            <TerminalPane
              target={{
                name: "staging-api",
                user: "reader",
                host: "staging.lab.ssterm.invalid",
                port: 2222,
              }}
              state="error"
            />
            <SnippetComposer target={fixtureTarget} />
          </div>
        </CardContent>
        <CardFooter>
          <Badge variant="fixture">Static output · no terminal engine</Badge>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>SFTP & transfer queue</CardTitle>
          <CardDescription>
            Separate local / remote roots, direction, conflict decisions,
            cancellation and partial-file explanation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FileTransferRecipe />
        </CardContent>
        <CardFooter>
          <span className="fixture-caption">
            UI composition only. No files are read, uploaded or changed.
          </span>
        </CardFooter>
      </Card>
      <div className="recipe-grid">
        <TunnelRecipe />
        <CredentialRecipe />
      </div>
      <div className="recipe-grid">
        <Card>
          <CardHeader>
            <CardTitle>Do · retain the target</CardTitle>
            <CardDescription>
              Context belongs beside every command action.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TerminalPane target={fixtureTarget} state="disconnected" />
          </CardContent>
          <CardFooter>
            <span className="fixture-caption">
              Status is explicit, even with inactive connection history.
            </span>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Avoid · ambiguous operational state</CardTitle>
            <CardDescription>
              A blue selection mark alone cannot mean connected.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-primary"
              />
              <span>prod-api-01</span>
            </div>
            <p className="fixture-caption mt-4">
              This deliberately incomplete example omits the connection label,
              user and host. Use the complete identity composition beside it.
            </p>
          </CardContent>
          <CardFooter>
            <span className="type-caption text-destructive">
              Review example · never use for command execution.
            </span>
          </CardFooter>
        </Card>
      </div>
    </Section>
  );
}
