import { KeyRoundIcon, LockKeyholeIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ConnectionStatus } from "@/components/connection/connection-status";

export function TunnelRecipe() {
  return (
    <section className="recipe-panel" aria-label="Local tunnel fixture">
      <div className="recipe-panel-header">
        <h3>Local port forwarding</h3>
        <Badge variant="fixture">Fixture</Badge>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="type-label">Database via lab bastion</span>
          <ConnectionStatus state="error" />
        </div>
        <p className="type-code break-all">
          127.0.0.1:5433 → db.lab.ssterm.invalid:5432
        </p>
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>Port 5433 is already in use</AlertTitle>
          <AlertDescription>
            Choose another local port or stop the application using it. This
            fixture has no listener.
          </AlertDescription>
        </Alert>
        <Button variant="outline" disabled className="self-start">
          Start tunnel
        </Button>
        <p className="fixture-caption">
          Local tunnels bind to loopback by default. Real start, stop and socket
          cleanup belong to the tunnel service.
        </p>
      </div>
    </section>
  );
}
export function CredentialRecipe() {
  return (
    <section className="recipe-panel" aria-label="Credential fixture">
      <div className="recipe-panel-header">
        <h3>Identity</h3>
        <Badge variant="fixture">Fixture</Badge>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" aria-hidden="true" />
          <span className="type-label">Lab deploy key</span>
          <Badge variant="secondary">SSH key</Badge>
        </div>
        <p className="fixture-caption">
          Referenced by 2 fixture hosts. Only the label and type are shown.
        </p>
        <FieldGroup>
          <Field data-disabled>
            <FieldLabel htmlFor="credential-fixture">
              Private key passphrase
            </FieldLabel>
            <Input
              id="credential-fixture"
              type="password"
              placeholder="Hidden"
              disabled
              autoComplete="off"
              aria-describedby="credential-help"
            />
            <FieldDescription id="credential-help">
              Secret entry and storage are unavailable. This fixture contains no
              credential.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <div className="flex items-center gap-2 type-caption">
          <LockKeyholeIcon className="size-4" aria-hidden="true" /> Locked · no
          secret loaded
        </div>
        <Button variant="outline" disabled className="self-start">
          Unlock identity
        </Button>
      </div>
    </section>
  );
}
