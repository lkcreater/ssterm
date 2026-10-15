import { ChevronDownIcon, FolderIcon, ServerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ConnectionStatus } from "@/components/connection/connection-status";
import { HostIdentity } from "@/components/connection/host-identity";
import { SessionTab } from "@/components/workspace/session-tab";
import { StateMatrix, previewState } from "./state-matrix";
import { Example, Section } from "./section";
import { fixtureTarget } from "./recipes";

export function Navigation() {
  return (
    <Section
      id="navigation"
      title="Navigation & workspace identity"
      description="Blue identifies selection and focus; status icon and text identify connection health. Every command surface retains its full target and an explicit PROD label."
    >
      <div className="showcase-grid">
        <Example title="Connection status">
          <div className="flex flex-col items-start gap-4">
            <ConnectionStatus state="connected" />
            <ConnectionStatus state="connecting" />
            <ConnectionStatus state="error" />
            <ConnectionStatus state="disconnected" />
          </div>
          <HostIdentity target={fixtureTarget} copy />
        </Example>
        <Example title="Independent states">
          <SessionTab name="prod-api-01" state="connected" active production />
          <SessionTab name="staging-api-02" state="connected" />
          <SessionTab name="prod-api-03" state="error" active production />
          <SessionTab name="focus-connected-04" state="connected" focused />
          <SessionTab name="lab-offline-05" state="disconnected" active />
          <SessionTab
            name="ระบบสำรองข้อมูลในศูนย์ข้อมูล-production-ap-southeast-1"
            state="connecting"
          />
        </Example>
      </div>
      <Example title="Sidebar / tree / scroll / collapsible">
        <div className="recipe-panel flex h-72 overflow-hidden">
          <SidebarProvider
            className="min-h-0 w-60 shrink-0"
            style={{ "--sidebar-width": "240px" } as React.CSSProperties}
          >
            <Sidebar collapsible="none">
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupLabel>Fixture servers</SidebarGroupLabel>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive>
                        <ServerIcon />
                        <span>All servers</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton disabled>
                        <FolderIcon />
                        <span>Unavailable group</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                  <Collapsible defaultOpen>
                    <CollapsibleTrigger render={<Button variant="ghost" />}>
                      <ChevronDownIcon data-icon="inline-start" /> Bangkok lab
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="px-3 py-2">
                        <SessionTab
                          name="ระบบทดสอบชื่อยาวมากสำหรับตรวจการตัดข้อความ"
                          state="connected"
                        />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </SidebarGroup>
              </SidebarContent>
            </Sidebar>
          </SidebarProvider>
          <Separator orientation="vertical" />
          <ScrollArea className="h-72 min-w-0 flex-1 p-4">
            <div className="flex flex-col gap-3">
              {Array.from({ length: 12 }, (_, index) => (
                <SessionTab
                  key={index}
                  name={`lab-node-${String(index + 1).padStart(2, "0")}`}
                  state={index === 2 ? "error" : "disconnected"}
                  active={index === 2}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      </Example>
      <Example title="Tabs & resize">
        <Tabs defaultValue="terminal">
          <TabsList aria-label="Fixture session tools">
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="tunnels" disabled>
              Tunnels unavailable
            </TabsTrigger>
          </TabsList>
          <TabsContent value="terminal">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-48 rounded-lg border"
            >
              <ResizablePanel defaultSize="50%" minSize="25%">
                <div className="p-4">
                  <HostIdentity target={fixtureTarget} />
                  <p className="fixture-caption mt-3">
                    Fixture pane A. Drag the separator or focus it and use arrow
                    keys.
                  </p>
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle aria-label="Resize fixture panes" />
              <ResizablePanel defaultSize="50%" minSize="25%">
                <div className="p-4">
                  <HostIdentity
                    target={{
                      name: "lab-db",
                      user: "reader",
                      host: "db.lab.ssterm.invalid",
                      port: 22,
                    }}
                  />
                  <p className="fixture-caption mt-3">
                    Fixture pane B. Each pane has its own execution target.
                  </p>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </TabsContent>
          <TabsContent value="files">
            <p className="p-4 fixture-caption">
              File browser composition appears in the integrated recipes below.
            </p>
          </TabsContent>
        </Tabs>
      </Example>
      <StateMatrix
        rows={["tabs"] as const}
        states={["default", "hover", "active", "focus", "disabled"]}
        render={(_, state) => (
          <Tabs defaultValue="terminal">
            <TabsList aria-label={`Tabs ${state} fixture`}>
              <TabsTrigger value="terminal" {...previewState(state)}>
                Terminal
              </TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      />
    </Section>
  );
}
