import { useState } from "react";
import {
  InfoIcon,
  MoreHorizontalIcon,
  TriangleAlertIcon,
  FolderIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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
import { Section, Example } from "./section";

export function Feedback() {
  const [open, setOpen] = useState(false);
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
      <Example title="Dialog · focus trap and return">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button variant="outline" />}>
            Open host dialog fixture
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Host details · fixture</DialogTitle>
              <DialogDescription>
                Review local form behavior. No host is saved and no connection
                is opened.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="dialog-host-name">
                  Fixture host name
                </FieldLabel>
                <Input id="dialog-host-name" defaultValue="Bangkok lab" />
                <FieldDescription>
                  Try Tab, Shift+Tab and Escape. Focus returns to the opening
                  button.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="dialog-host-address">
                  Fixture host address
                </FieldLabel>
                <Input
                  id="dialog-host-address"
                  defaultValue="lab.ssterm.invalid"
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Cancel fixture
              </DialogClose>
              <Button
                onClick={() => {
                  setOpen(false);
                  toast.add({
                    title: "Fixture reviewed",
                    description: "No host was saved.",
                    type: "info",
                  });
                }}
              >
                Review fixture
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Example>
      <div className="showcase-grid">
        <Example title="Sheet">
          <Sheet>
            <SheetTrigger render={<Button variant="outline" />}>
              Open target sheet fixture
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Target details · fixture</SheetTitle>
                <SheetDescription>
                  Full, selectable execution target.
                </SheetDescription>
              </SheetHeader>
              <p className="px-4 type-code break-all select-text">
                deploy@production-api-with-a-very-long-hostname.lab.ssterm.invalid:22
              </p>
              <SheetFooter>
                <SheetClose render={<Button variant="outline" />}>
                  Close fixture
                </SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </Example>
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
