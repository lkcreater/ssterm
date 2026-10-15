import {
  CircleIcon,
  FolderIcon,
  KeyRoundIcon,
  LayersIcon,
  LockKeyholeIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  TerminalIcon,
  WorkflowIcon,
} from "lucide-react";
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
import iconLogo from "@/assets/icon-logo.png";

const unavailable = [
  { label: "Identities", icon: KeyRoundIcon },
  { label: "Snippets", icon: LayersIcon },
  { label: "Port forwarding", icon: WorkflowIcon },
] as const;

export function AppShell() {
  const desktop = useDesktopState();
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
                    <SidebarMenuButton isActive aria-current="page">
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
              <h1 className="type-label">Workspace</h1>
            </div>
            <span className="type-caption text-muted-foreground">
              No active sessions
            </span>
          </div>
          <div className="workspace-empty">
            <Empty>
              <EmptyHeader>
                <img
                  src={iconLogo}
                  alt="ssterm monogram"
                  className="empty-mark"
                />
                <EmptyTitle>No servers yet</EmptyTitle>
                <EmptyDescription>
                  A calm place for your connected systems. Your workspace is
                  ready; server setup is coming in a future update.
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
            `ssterm ${desktop.data.app.version} · Local workspace`
          ) : (
            "Local workspace"
          )}
        </span>
      </footer>
    </div>
  );
}
