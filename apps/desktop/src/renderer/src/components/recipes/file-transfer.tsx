import { useRef, useState, type RefObject } from "react";
import { Drawer, useDrawerClose } from "@/components/drawer";
import {
  ArrowRightIcon,
  FileIcon,
  FolderIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Field, FieldGroup, FieldTitle } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";

const longFile = "รายงานระบบ-production-backup-2026-10-15.tar.gz";
function FilePane({
  title,
  root,
  remote = false,
}: {
  title: string;
  root: string;
  remote?: boolean;
}) {
  return (
    <section className="recipe-panel" aria-label={title}>
      <div className="recipe-panel-header">
        <h3>{title}</h3>
        <Badge variant="fixture">Fixture</Badge>
      </div>
      <ScrollArea className="h-36">
        <div className="min-w-0 p-3">
          <p className="type-code break-all">{root}</p>
          <div className="recipe-row">
            <FolderIcon aria-hidden="true" />
            <span>logs</span>
          </div>
          <div className="recipe-row">
            <FileIcon aria-hidden="true" />
            <span className="break-all">{remote ? "app.conf" : longFile}</span>
          </div>
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </section>
  );
}
function ConflictFixtureDrawer({
  opener,
  onClose,
}: {
  opener: RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const [choice, setChoice] = useState<string[]>([]);
  const close = useDrawerClose();
  return (
    <Drawer
      close={close}
      onClose={onClose}
      finalFocus={opener}
      title="app.conf already exists"
      target={
        <span className="min-w-0 break-all">
          deploy@lab.ssterm.invalid:/srv/app/app.conf
        </span>
      }
      description="Fixture destination. Choose an explicit conflict policy; no file will be changed."
      footer={
        <>
          <Button variant="outline" onClick={close.request}>
            Cancel
          </Button>
          <Button
            disabled={!choice.length}
            onClick={() => {
              close.discard();
              toast.add({
                title: "Fixture choice recorded",
                description: `Selected: ${choice[0]}. No file was changed.`,
                type: "info",
              });
            }}
          >
            Preview choice
          </Button>
        </>
      }
    >
      <FieldGroup>
        <Field>
          <FieldTitle id="conflict-policy">Conflict policy</FieldTitle>
          <ToggleGroup
            aria-labelledby="conflict-policy"
            value={choice}
            onValueChange={(values) => {
              if (values.length) setChoice(values);
            }}
            variant="outline"
          >
            <ToggleGroupItem value="skip">Skip</ToggleGroupItem>
            <ToggleGroupItem value="rename">Rename</ToggleGroupItem>
            <ToggleGroupItem value="replace">Replace</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </FieldGroup>
    </Drawer>
  );
}

export function FileTransferRecipe() {
  // Serial per open: each open is a fresh drawer instance.
  const [open, setOpen] = useState(0);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="recipe-grid">
        <FilePane title="Local files" root="/Users/fixture/Downloads" />
        <FilePane
          title="Remote files"
          root="deploy@lab.ssterm.invalid:/srv/app"
          remote
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 type-caption">
          Local <ArrowRightIcon className="size-4" aria-hidden="true" /> Remote
          · upload fixture
        </span>
        <Button variant="outline" disabled>
          Upload selected
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>File</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>
              <span className="block max-w-72 break-all whitespace-normal">
                {longFile}
              </span>
            </TableCell>
            <TableCell>
              <Progress value={48} aria-label="Fixture upload progress">
                <ProgressLabel>Uploading · fixture</ProgressLabel>
                <ProgressValue />
              </Progress>
            </TableCell>
            <TableCell>
              <Button variant="outline" disabled>
                Cancel
              </Button>
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell>app.conf</TableCell>
            <TableCell>Destination exists</TableCell>
            <TableCell>
              <Button
                ref={opener}
                variant="outline"
                onClick={() => setOpen((serial) => serial + 1)}
              >
                Review conflict fixture
              </Button>
              {open ? (
                <ConflictFixtureDrawer
                  key={open}
                  opener={opener}
                  onClose={() => setOpen(0)}
                />
              ) : null}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <Alert variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>Upload interrupted · fixture</AlertTitle>
        <AlertDescription>
          app.conf was not replaced. A partial upload would remain separate
          until verification. Transfers and cancellation are unavailable in this
          preview.
        </AlertDescription>
      </Alert>
    </div>
  );
}
