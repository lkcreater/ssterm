import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import {
  CircleAlertIcon,
  CopyIcon,
  FileKeyIcon,
  KeyRoundIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  TextCursorInputIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserRoundIcon,
} from "lucide-react";
import {
  MAX_CATALOG_ITEMS,
  type CatalogIdentity,
  type CatalogKey,
  type CatalogState,
  type IdentityMethod,
  type Owner,
} from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Catalog } from "@/hooks/use-catalog";
import {
  algorithmLabel,
  credentialStatus,
  identityUsages,
  keyInUseReason,
  keyUsers,
  methodLabels,
  usageOf,
  usageText,
  type CredentialTone,
} from "@/lib/identity-usage";
import { DeleteIdentityDialog, IdentityEditor } from "./identity-dialogs";
import { ImportKeyDialog, KeyActionDialog, ProblemAlert, RenameKeyDialog, requestProblem, storeProblem } from "./key-dialogs";
import { call, copyText } from "./secret-input";

type Tab = "identities" | "keys";
type Dialog =
  | { kind: "identity"; id?: string }
  | { kind: "delete-identity"; id: string }
  | { kind: "import" }
  | { kind: "rename-key" | "forget-passphrase" | "delete-key"; id: string };

const methodIcons = {
  password: TextCursorInputIcon,
  key: KeyRoundIcon,
  "keyboard-interactive": MessagesSquareIcon,
} as const;
const toneIcons: Record<CredentialTone, typeof ShieldCheckIcon> = {
  saved: ShieldCheckIcon,
  asks: MessageCircleQuestionIcon,
  key: FileKeyIcon,
  unresolved: TriangleAlertIcon,
  missing: CircleAlertIcon,
};

export function MethodBadge({ method }: { method: IdentityMethod }) {
  const Icon = methodIcons[method];
  return (
    <Badge variant="secondary">
      <Icon data-icon="inline-start" aria-hidden="true" />
      {methodLabels[method]}
    </Badge>
  );
}
function CredentialStatus({ tone, text }: { tone: CredentialTone; text: string }) {
  const Icon = toneIcons[tone];
  return (
    <span className="credential-status" data-tone={tone}>
      <Icon aria-hidden="true" />
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
    </span>
  );
}

const heading = () => document.querySelector<HTMLElement>('[data-testid="identities-page"] h2');

export function IdentitiesPage({ owner, catalog, state }: { owner: Owner; catalog: Catalog; state: CatalogState }) {
  const [tab, setTab] = useState<Tab>("identities");
  // Each open gets its own drawer instance, so reopening during the previous one's exit motion is never closed by it.
  const [dialog, setDialogState] = useState<Dialog & { key: number }>();
  const dialogKey = useRef(0);
  const setDialog = (next: Dialog) => setDialogState({ ...next, key: ++dialogKey.current });
  const [notice, setNotice] = useState<{ title: string; text: string; tone?: "status" }>();
  const [retrying, setRetrying] = useState(false);
  const [copied, setCopied] = useState<string>();
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const usages = useMemo(() => identityUsages(state.hosts, state.groups), [state.hosts, state.groups]);
  const keys = useMemo(() => new Map(state.keys.map((key) => [key.id, key])), [state.keys]);
  const secretsReady = state.secrets.availability === "ready";
  const close = () => setDialogState(undefined);
  const find = <T extends { id: string }>(rows: readonly T[], id?: string) => rows.find((row) => row.id === id);
  const deletingIdentity = dialog?.kind === "delete-identity" ? find(state.identities, dialog.id) : undefined;
  const keyDialog = dialog && "id" in dialog && dialog.kind !== "identity" && dialog.kind !== "delete-identity" ? find(state.keys, dialog.id) : undefined;
  // A deletion can remove its row (unmounting the drawer) before the drawer reports closing: drop the stale dialog.
  const stale = !!dialog && ((dialog.kind === "delete-identity" && !deletingIdentity) || (dialog.kind !== "identity" && dialog.kind !== "delete-identity" && dialog.kind !== "import" && !keyDialog));
  useEffect(() => {
    if (stale) setDialogState(undefined);
  }, [stale]);

  async function retrySecrets() {
    if (retrying) return;
    setRetrying(true);
    setNotice(undefined);
    const result = await call((bridge) => bridge.retrySecrets({ owner }));
    setRetrying(false);
    if (!result.ok) setNotice(requestProblem(result.error.code, "Keychain changes are still unresolved"));
    else if (result.value.status === "secret-store")
      setNotice(storeProblem(result.value.reason, "Keychain changes are still unresolved"));
  }
  function copy(key: CatalogKey) {
    if (!copyText(key.publicKey))
      return setNotice({ title: "The public key was not copied", text: "Copying is unavailable right now. Try again." });
    setNotice(undefined);
    setCopied(key.id);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(undefined), 2000);
  }
  const focusRow = (selector: string) => setTimeout(() => (document.querySelector<HTMLElement>(selector) ?? heading())?.focus());

  const identities = state.identities;
  const empty = tab === "identities" ? identities.length === 0 : state.keys.length === 0;
  const retry = (
    <Button variant="outline" size="sm" disabled={retrying} onClick={() => void retrySecrets()}>
      <RotateCwIcon data-icon="inline-start" /> Retry
    </Button>
  );
  return (
    <div className="catalog-page" data-testid="identities-page">
      <PageHeader
        title="Identities"
        subtitle="Users, passwords and SSH keys for your servers, kept in the macOS Keychain."
        actions={empty ? null : tab === "identities" ? (
          <Button size="sm" onClick={() => setDialog({ kind: "identity" })}>
            <PlusIcon data-icon="inline-start" /> New identity
          </Button>
        ) : (
          <Button size="sm" disabled={!secretsReady} onClick={() => setDialog({ kind: "import" })}>
            <FileKeyIcon data-icon="inline-start" /> Import key…
          </Button>
        )}
      />
      {secretsReady ? null : (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>The macOS Keychain is unavailable</AlertTitle>
          <AlertDescription>
            Passwords, keys and passphrases cannot be saved right now. Identities can still ask for a password when connecting.
          </AlertDescription>
        </Alert>
      )}
      {state.secrets.cleanupPending ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Some Keychain items are waiting to be removed</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span>ssterm could not finish removing secrets it no longer uses. Retry when the Keychain is available.</span>
            <span>{retry}</span>
          </AlertDescription>
        </Alert>
      ) : null}
      {notice ? <ProblemAlert problem={notice} /> : null}
      <span role="status" className="sr-only">
        {copied ? "Public key copied" : ""}
      </span>
      {state.truncated ? (
        <p className="type-caption text-muted-foreground">Showing the first {MAX_CATALOG_ITEMS.toLocaleString()} items of each kind.</p>
      ) : null}
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="min-h-0 flex-1">
        <TabsList variant="line" aria-label="Identities and keys">
          <TabsTrigger value="identities">Identities</TabsTrigger>
          <TabsTrigger value="keys">SSH keys</TabsTrigger>
        </TabsList>
        <TabsContent value="identities" className="min-h-0">
          {identities.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UserRoundIcon />
                </EmptyMedia>
                <EmptyTitle>No identities yet</EmptyTitle>
                <EmptyDescription>
                  An identity is a user name and how to sign in. Servers and groups choose one to connect.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setDialog({ kind: "identity" })}>
                  <PlusIcon data-icon="inline-start" /> New identity
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <ul className="identity-list" aria-label="Identities">
              {identities.map((identity) => (
                <IdentityRow
                  key={identity.id}
                  identity={identity}
                  usage={usageText(usageOf(usages, identity.id))}
                  status={credentialStatus(identity, keys)}
                  retry={retry}
                  onEdit={() => setDialog({ kind: "identity", id: identity.id })}
                  onDelete={() => setDialog({ kind: "delete-identity", id: identity.id })}
                />
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="keys" className="min-h-0">
          {state.keys.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRoundIcon />
                </EmptyMedia>
                <EmptyTitle>No SSH keys yet</EmptyTitle>
                <EmptyDescription>
                  Import an OpenSSH Ed25519 or PEM RSA private key. ssterm keeps it in the macOS Keychain and never shows it again.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setDialog({ kind: "import" })} disabled={!secretsReady}>
                  <FileKeyIcon data-icon="inline-start" /> Import key…
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <ul className="identity-list" aria-label="SSH keys">
              {state.keys.map((key) => (
                <KeyRow
                  key={key.id}
                  keyItem={key}
                  users={keyUsers(identities, key.id).map((identity) => identity.label)}
                  copied={copied === key.id}
                  retry={retry}
                  onCopy={() => copy(key)}
                  onRename={() => setDialog({ kind: "rename-key", id: key.id })}
                  onForget={() => setDialog({ kind: "forget-passphrase", id: key.id })}
                  onDelete={() => setDialog({ kind: "delete-key", id: key.id })}
                />
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
      {dialog?.kind === "identity" ? (
        <IdentityEditor
          key={dialog.key}
          owner={owner}
          catalog={catalog}
          state={state}
          identityId={dialog.id}
          usage={dialog.id ? usageOf(usages, dialog.id) : undefined}
          onClose={close}
          onRetrySecrets={retrySecrets}
          onSaved={(id) => {
            close();
            focusRow(`[data-identity-id="${CSS.escape(id)}"] button`);
          }}
        />
      ) : null}
      {deletingIdentity ? (
        <DeleteIdentityDialog
          key={dialog?.key}
          catalog={catalog}
          state={state}
          identity={deletingIdentity}
          usage={usageOf(usages, deletingIdentity.id)}
          onClose={close}
          onDeleted={close}
          afterDelete={() =>
            document.querySelector<HTMLElement>(
              `[data-identity-id]:not([data-identity-id="${CSS.escape(deletingIdentity.id)}"]) button`,
            ) ?? heading()
          }
        />
      ) : null}
      {dialog?.kind === "import" ? (
        <ImportKeyDialog
          key={dialog.key}
          owner={owner}
          secretsReady={secretsReady}
          onClose={close}
          onImported={(keyId) => {
            close();
            focusRow(`[data-key-id="${CSS.escape(keyId)}"] button`);
          }}
        />
      ) : null}
      {keyDialog && dialog?.kind === "rename-key" ? <RenameKeyDialog key={dialog.key} owner={owner} keyItem={keyDialog} onClose={close} /> : null}
      {keyDialog && (dialog?.kind === "forget-passphrase" || dialog?.kind === "delete-key") ? (
        <KeyActionDialog
          key={dialog.key}
          owner={owner}
          keyItem={keyDialog}
          action={dialog.kind === "delete-key" ? "delete" : "forget-passphrase"}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

function IdentityRow({
  identity,
  usage,
  status,
  retry,
  onEdit,
  onDelete,
}: {
  identity: CatalogIdentity;
  usage: string;
  status: { tone: CredentialTone; text: string };
  retry: React.ReactNode;
  onEdit(): void;
  onDelete(): void;
}) {
  return (
    <li className="identity-row" data-identity-id={identity.id}>
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium" title={identity.label}>
            {identity.label}
          </span>
          <MethodBadge method={identity.method} />
        </div>
        <span className="host-target truncate" title={identity.username}>
          {identity.username}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 type-caption">
          <CredentialStatus {...status} />
          <span className="min-w-0 text-muted-foreground">{usage}</span>
        </div>
        {status.tone === "unresolved" ? <span>{retry}</span> : null}
      </div>
      <div className="identity-actions">
        <Button variant="outline" size="sm" aria-label={`Edit ${identity.label}`} onClick={onEdit}>
          <PencilIcon data-icon="inline-start" /> Edit
        </Button>
        <Button variant="outline" size="sm" aria-label={`Delete ${identity.label}`} onClick={onDelete}>
          <Trash2Icon data-icon="inline-start" /> Delete
        </Button>
      </div>
    </li>
  );
}

function KeyRow({
  keyItem,
  users,
  copied,
  retry,
  onCopy,
  onRename,
  onForget,
  onDelete,
}: {
  keyItem: CatalogKey;
  users: string[];
  copied: boolean;
  retry: React.ReactNode;
  onCopy(): void;
  onRename(): void;
  onForget(): void;
  onDelete(): void;
}) {
  const reason = keyInUseReason(users);
  const reasonId = `${keyItem.id}-delete-reason`;
  return (
    <li className="identity-row" data-kind="key" data-key-id={keyItem.id}>
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium" title={keyItem.label}>
            {keyItem.label}
          </span>
          <Badge variant="secondary">{algorithmLabel(keyItem.algorithm)}</Badge>
          {keyItem.passphraseSaved ? <Badge variant="outline">Passphrase saved</Badge> : null}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={<span tabIndex={0} className="host-target w-fit max-w-full truncate" aria-label={`Fingerprint ${keyItem.fingerprint}`} />}
          >
            {keyItem.fingerprint}
          </TooltipTrigger>
          <TooltipContent className="max-w-[min(90vw,40rem)] font-mono break-all">{keyItem.fingerprint}</TooltipContent>
        </Tooltip>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 type-caption">
          {keyItem.pending ? <CredentialStatus tone="unresolved" text="Keychain change unresolved" /> : null}
          <span className="text-muted-foreground">
            {users.length
              ? `Used by ${users.length} ${users.length === 1 ? "identity" : "identities"}`
              : "Not used by any identities"}
          </span>
        </div>
        {keyItem.pending ? <span>{retry}</span> : null}
      </div>
      <div className="identity-actions">
        <Button variant="outline" size="sm" aria-label={`${copied ? "Copied" : "Copy"} public key for ${keyItem.label}`} onClick={onCopy}>
          <CopyIcon data-icon="inline-start" /> {copied ? "Copied" : "Copy public key"}
        </Button>
        <Button variant="outline" size="sm" aria-label={`Rename ${keyItem.label}`} onClick={onRename}>
          <PencilIcon data-icon="inline-start" /> Rename
        </Button>
        {keyItem.passphraseSaved ? (
          <Button variant="outline" size="sm" aria-label={`Forget passphrase for ${keyItem.label}`} onClick={onForget}>
            Forget passphrase
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          aria-label={`Delete ${keyItem.label}`}
          aria-disabled={reason ? true : undefined}
          aria-describedby={reason ? reasonId : undefined}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (!reason) onDelete();
          }}
        >
          <Trash2Icon data-icon="inline-start" /> Delete
        </Button>
      </div>
      {reason ? (
        <p id={reasonId} className="type-caption text-muted-foreground">
          {reason}
        </p>
      ) : null}
    </li>
  );
}
