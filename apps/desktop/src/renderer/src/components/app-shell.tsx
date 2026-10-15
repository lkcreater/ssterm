import { useState } from "react";
import {
  AlertCircleIcon,
  CircleIcon,
  FolderIcon,
  KeyRoundIcon,
  LayersIcon,
  LockKeyholeIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  ServerIcon,
  TerminalIcon,
  WorkflowIcon,
} from "lucide-react";
import type { StorageProblem } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useDesktopState } from "@/hooks/use-desktop-state";
import { useKnownHosts } from "@/hooks/use-known-hosts";
import {
  KnownHostsWorkspace,
  HostTrustDialogs,
} from "@/components/trust/known-hosts";
import iconLogo from "@/assets/icon-logo.png";

const unavailable = [
  { label: "Identities", icon: KeyRoundIcon },
  { label: "Snippets", icon: LayersIcon },
  { label: "Port forwarding", icon: WorkflowIcon },
] as const;

const storageProblems: Record<
  StorageProblem,
  { title: string; description: string }
> = {
  corrupt: {
    title: "Workspace storage needs recovery",
    description:
      "Keep the original workspace files. Use a verified recovery copy or backup before reopening this workspace.",
  },
  "foreign-database": {
    title: "Workspace storage is not recognized",
    description:
      "Keep the original files and restore a verified ssterm workspace copy before trying again.",
  },
  "unsupported-schema": {
    title: "A newer ssterm version is required",
    description:
      "Open this workspace with a compatible newer version of ssterm. Keep the original files intact.",
  },
  "unsupported-protection": {
    title: "Workspace protection is not supported",
    description:
      "Use a ssterm version that supports this workspace's protection format. Keep the original files intact.",
  },
  "recovery-required": {
    title: "Workspace recovery is pending",
    description:
      "Pending credential changes need reconciliation before this workspace can open. Keep the original files and use a compatible recovery version.",
  },
  unwritable: {
    title: "Workspace storage needs private access",
    description:
      "Check disk space, your account's access and private permissions for the workspace folder and files, then reopen ssterm.",
  },
  "migration-failed": {
    title: "Workspace upgrade could not finish",
    description:
      "Keep the original files and the pre-upgrade backup. Use a verified recovery copy with a compatible version of ssterm.",
  },
  busy: {
    title: "Workspace storage is in use",
    description:
      "Close other ssterm instances using this workspace, then close and reopen this window.",
  },
  unavailable: {
    title: "Workspace storage is unavailable",
    description:
      "Close and reopen ssterm to try again. If the problem continues, keep the original files and use a verified backup or recovery copy.",
  },
};

export function AppShell() {
  const desktop = useDesktopState();
  const [page, setPage] = useState<"servers" | "known-hosts">("servers");
  const owner = desktop.status === "ready" ? desktop.data.owner : undefined;
  const trust = useKnownHosts(owner);
  const storage = desktop.status === "ready" ? desktop.data.storage : undefined;
  const problem =
    storage?.status === "blocked" ? storageProblems[storage.code] : undefined;
  const emptyTitle =
    problem || desktop.status === "unavailable"
      ? "Workspace is unavailable"
      : desktop.status === "loading"
        ? "Opening workspace"
        : "No servers yet";
  return (
    <div
      className="app-shell"
      data-window-focused={
        desktop.status === "ready" ? desktop.data.window.focused : undefined
      }
    >
      <header className="app-toolbar">
        <img src={iconLogo} alt="" className="size-8" />
        <span className="type-label">ssterm</span>
        <Separator orientation="vertical" className="mx-1 h-4 self-center" />
        <span className="type-caption text-muted-foreground">
          Local workspace
        </span>
        <Badge variant="outline" className="ml-auto">
          <LockKeyholeIcon data-icon="inline-start" /> No account needed
        </Badge>
      </header>
      <SidebarProvider
        className="app-layout min-h-0"
        style={{ "--sidebar-width": "240px" } as React.CSSProperties}
      >
        <Sidebar collapsible="none" className="app-sidebar">
          <SidebarHeader className="gap-4 p-4">
            <div className="flex items-center justify-between">
              <span className="type-label">Servers</span>
              <Button
                variant="ghost"
                size="icon"
                disabled
                aria-label="Add server unavailable"
              >
                <PlusIcon />
              </Button>
            </div>
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search servers"
                placeholder="Search servers"
                disabled
              />
            </InputGroup>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Library</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={page === "servers"}
                      aria-current={page === "servers" ? "page" : undefined}
                      onClick={() => setPage("servers")}
                    >
                      <ServerIcon />
                      <span>All servers</span>
                      <span className="ml-auto type-caption">0</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton disabled>
                      <FolderIcon />
                      <span>Groups</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace tools</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={page === "known-hosts"}
                      aria-current={page === "known-hosts" ? "page" : undefined}
                      onClick={() => setPage("known-hosts")}
                      disabled={storage?.status !== "ready"}
                    >
                      <ShieldCheckIcon />
                      <span>Known hosts</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {unavailable.map(({ label, icon: Icon }) => (
                    <SidebarMenuItem key={label}>
                      <SidebarMenuButton disabled>
                        <Icon />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <p className="sidebar-note">
              Server setup and workspace tools will be available in a future
              update.
            </p>
          </SidebarContent>
          <SidebarFooter className="gap-3 p-4">
            <Separator />
            <div className="flex items-center gap-2 type-caption text-muted-foreground">
              <LockKeyholeIcon className="size-4" aria-hidden="true" />
              <span>On this Mac</span>
            </div>
          </SidebarFooter>
        </Sidebar>
        <main className="app-workspace">
          <div className="workspace-toolbar">
            <div className="flex items-center gap-2">
              <TerminalIcon
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <h1 className="type-label">
                {page === "known-hosts" ? "Known hosts" : "Workspace"}
              </h1>
            </div>
            <span className="type-caption text-muted-foreground">
              No active sessions
            </span>
          </div>
          {page === "known-hosts" ? (
            <KnownHostsWorkspace
              key={
                owner ? `${owner.windowId}:${owner.generation}` : "unavailable"
              }
              owner={owner}
              state={trust.state}
              error={trust.error}
            />
          ) : (
            <div className="workspace-empty">
              <Empty>
                <EmptyHeader>
                  <img
                    src={iconLogo}
                    alt="ssterm monogram"
                    className="empty-mark"
                  />
                  <EmptyTitle>{emptyTitle}</EmptyTitle>
                  <EmptyDescription>
                    {storage?.status === "ready"
                      ? "A calm place for your connected systems. Your workspace is ready; server setup is coming in a future update."
                      : "Your workspace must open successfully before saved servers can be shown. Server setup is coming in a future update."}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button disabled>
                    <PlusIcon data-icon="inline-start" /> Add server
                  </Button>
                  <span className="type-caption text-muted-foreground">
                    Connections are not available in this version.
                  </span>
                </EmptyContent>
              </Empty>
            </div>
          )}
          {problem ? (
            <div className="px-5 pb-4">
              <Alert>
                <AlertCircleIcon aria-hidden="true" />
                <AlertTitle>{problem.title}</AlertTitle>
                <AlertDescription>{problem.description}</AlertDescription>
              </Alert>
            </div>
          ) : null}
          {desktop.status === "unavailable" ? (
            <div className="px-5 pb-4">
              <Alert>
                <CircleIcon aria-hidden="true" />
                <AlertTitle>Workspace information is unavailable</AlertTitle>
                <AlertDescription>
                  Close this window and reopen ssterm to try again.
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
        </main>
      </SidebarProvider>
      <HostTrustDialogs state={trust.state} />
      <footer className="app-statusbar">
        <CircleIcon className="size-3" aria-hidden="true" />
        <span>No connections</span>
        <span className="ml-auto">
          {desktop.status === "loading" ? (
            <span className="flex items-center gap-2">
              <Spinner aria-label="Loading workspace information" /> Opening
              workspace
            </span>
          ) : desktop.status === "ready" ? (
            `ssterm ${desktop.data.app.version} · ${problem ? "Storage unavailable" : "Local workspace"}`
          ) : (
            "Local workspace"
          )}
        </span>
      </footer>
    </div>
  );
}
