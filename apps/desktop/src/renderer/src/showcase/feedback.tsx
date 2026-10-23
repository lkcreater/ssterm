import { useRef, useState } from "react";
import {
  InfoIcon,
  MoreHorizontalIcon,
  TriangleAlertIcon,
  FolderIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Drawer, useDrawerClose } from "@/components/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { ConnectionStatus } from "@/components/connection/connection-status";
import { EnvironmentBadge } from "@/components/connection/host-identity";
import { Section, Example } from "./section";

/** Alert drawer specimen (pattern 42): a confirmation step, Cancel focused, no dismissal by the scrim. */
function ConfirmDrawerFixture({ onClose }: { onClose(): void }) {
  const close = useDrawerClose();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Drawer
      close={close}
      onClose={onClose}
      alert
      initialFocus={cancel}
      title="Delete fixture rule?"
      target={<span className="min-w-0 break-all type-code">127.0.0.1:15432 → db.lab.ssterm.invalid:5432</span>}
      description="Nothing is deleted: this specimen only shows the destructive confirmation step."
      footer={
        <>
          <Button ref={cancel} variant="outline" onClick={close.request}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => close.discard()}>
            Delete fixture rule
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground">A running tunnel would stop first. Copies elsewhere are not affected.</p>
    </Drawer>
  );
}

/** v2 table states (SST-040/15): the framed table, its empty, loading and failure states, fixture data only. */
function TableStates() {
  return (
    <div className="grid gap-3">
      <div className="data-frame">
        <table className="data-table" aria-label="Fixture servers">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="w-[30%]">Address</th>
              <th scope="col" className="w-24">Environment</th>
              <th scope="col" className="w-36">Status</th>
            </tr>
          </thead>
          <tbody>
            {([["ฐานข้อมูลหลัก ระบบการเงิน", "ops@db.lab.ssterm.invalid:22", "PROD", "connected"],
              ["Staging web", "deploy@10.0.0.12:22", "STAGING", "connecting"],
              ["Dev box", "dev@dev.lab.ssterm.invalid:22", "DEV", "error"]] as const).map(([name, address, environment, state]) => (
              <tr key={name}>
                <td><span className="block truncate font-medium" title={name}>{name}</span></td>
                <td><span className="host-target block truncate" title={address}>{address}</span></td>
                <td><EnvironmentBadge environment={environment} /></td>
                <td><ConnectionStatus state={state} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="data-frame">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Spinner aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>Loading fixture rules…</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>
      <Alert variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>Fixture rules could not be read</AlertTitle>
        <AlertDescription>Nothing was changed; open the page again to retry.</AlertDescription>
      </Alert>
    </div>
  );
}

/** Right-edge drawer specimen: the shipping primitive, fixture-only; focus returns to the opener. */
function HostDrawerFixture({ onClose }: { onClose(): void }) {
  const close = useDrawerClose();
  return (
    <Drawer
      close={close}
      onClose={onClose}
      title="Host details · fixture"
      target={
        <span className="min-w-0 break-all type-code">
          deploy@production-api-with-a-very-long-hostname.lab.ssterm.invalid:22
        </span>
      }
      description="Review local form behavior. No host is saved and no connection is opened."
      footer={
        <>
          <Button variant="outline" onClick={close.request}>
            Cancel fixture
          </Button>
          <Button
            onClick={() => {
              close.discard();
              toast.add({
                title: "Fixture reviewed",
                description: "No host was saved.",
                type: "info",
              });
            }}
          >
            Review fixture
          </Button>
        </>
      }
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="drawer-host-name">Fixture host name</FieldLabel>
          <Input id="drawer-host-name" defaultValue="Bangkok lab" />
          <FieldDescription>
            Try Tab, Shift+Tab and Escape. Focus returns to the opening button.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="drawer-host-address">
            Fixture host address
          </FieldLabel>
          <Input id="drawer-host-address" defaultValue="lab.ssterm.invalid" />
        </Field>
      </FieldGroup>
    </Drawer>
  );
}

export function Feedback() {
  // The open drawer's key (0 = closed): each open is a fresh instance, even during the exit motion.
  const [open, setOpen] = useState(0);
  const [confirming, setConfirming] = useState(0);
  return (
    <Section
      id="feedback"
      title="Feedback & overlays"
      description="Real Base UI focus management, keyboard dismissal and return focus. Feedback names the affected resource. All operations here are fixture-only."
    >
      <div className="showcase-grid">
        <Example title="Empty">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderIcon />
              </EmptyMedia>
              <EmptyTitle>No matching hosts</EmptyTitle>
              <EmptyDescription>
                Try another name or clear your group filter.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Example>
        <Example title="Loading">
          <div className="flex items-center gap-2">
            <Spinner />
            <span>Loading fixture hosts</span>
          </div>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Progress value={64}>
            <ProgressLabel>Fixture upload</ProgressLabel>
            <ProgressValue />
          </Progress>
        </Example>
        <Example title="Specific errors">
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>Authentication failed for lab-api</AlertTitle>
            <AlertDescription>
              Check the selected identity before trying again. No credential
              details are included.
            </AlertDescription>
          </Alert>
          <Alert>
            <InfoIcon aria-hidden="true" />
            <AlertTitle>Connection lost · fixture</AlertTitle>
            <AlertDescription>
              History remains visible. A manual reconnect creates a new session
              without replaying commands.
            </AlertDescription>
          </Alert>
        </Example>
      </div>
      <Example title="Drawer · focus trap and return">
        <Button
          variant="outline"
          onClick={() => setOpen((serial) => serial + 1)}
        >
          Open host drawer fixture
        </Button>
        {open ? (
          <HostDrawerFixture key={open} onClose={() => setOpen(0)} />
        ) : null}
        <Button variant="outline" onClick={() => setConfirming((serial) => serial + 1)}>
          Open confirmation drawer fixture
        </Button>
        {confirming ? (
          <ConfirmDrawerFixture key={confirming} onClose={() => setConfirming(0)} />
        ) : null}
      </Example>
      <Example title="Table states · empty, loading, failure">
        <TableStates />
      </Example>
      <div className="showcase-grid">
        <Example title="Menu & context menu">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <MoreHorizontalIcon data-icon="inline-start" /> Fixture host
              actions
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onClick={() =>
                    toast.add({
                      title: "Fixture details",
                      description: "No service action was performed.",
                    })
                  }
                >
                  Inspect fixture
                </DropdownMenuItem>
                <DropdownMenuItem disabled>
                  Connect unavailable
                </DropdownMenuItem>
                <DropdownMenuItem disabled variant="destructive">
                  Delete unavailable
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <ContextMenu>
            <ContextMenuTrigger className="rounded-lg border p-4" tabIndex={0}>
              Right-click for fixture actions
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuGroup>
                <ContextMenuItem
                  onClick={() =>
                    toast.add({
                      title: "Context menu fixture",
                      description: "No service action was performed.",
                    })
                  }
                >
                  Inspect fixture
                </ContextMenuItem>
                <ContextMenuItem disabled>
                  Reconnect unavailable
                </ContextMenuItem>
              </ContextMenuGroup>
            </ContextMenuContent>
          </ContextMenu>
        </Example>
        <Example title="Tooltip & toast">
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" />}>
              Inspect full target
            </TooltipTrigger>
            <TooltipContent>deploy@lab.ssterm.invalid:22</TooltipContent>
          </Tooltip>
          <Button
            variant="outline"
            onClick={() =>
              toast.add({
                title: "Preview notice",
                description: "This is a local showcase fixture.",
                type: "info",
              })
            }
          >
            Show fixture toast
          </Button>
        </Example>
      </div>
    </Section>
  );
}
