import { Drawer, useDrawerClose } from "@/components/drawer";
import { Button } from "@/components/ui/button";

// Mirrors lib/workspace-shortcuts.ts (window), terminal-input.ts (pane) and the app menu.
const groups: { title: string; rows: [keys: string, action: string][] }[] = [
  {
    title: "Tabs and panes",
    rows: [
      ["⌘D", "Split right"],
      ["⇧⌘D", "Split down"],
      ["⌘W", "Close pane"],
      ["⇧⌘↩", "Show only the active pane, or all panes"],
      ["⌥⌘← ↑ → ↓", "Move to the neighboring pane"],
      ["⌘1 – ⌘8", "Go to tab 1–8"],
      ["⌘9", "Go to the last tab"],
      ["⇧⌘]", "Next tab"],
      ["⇧⌘[", "Previous tab"],
    ],
  },
  {
    title: "Terminal",
    rows: [
      ["⌘F", "Find in terminal"],
      ["⌘;", "Command history suggestions at the prompt (Return inserts, never runs)"],
      ["⌘C", "Copy selection"],
      ["⌘V", "Paste"],
      ["⇧⌘S", "Snippets: Paste or Run on the active terminal"],
      ["⌘-click", "Open link"],
    ],
  },
  {
    title: "Files",
    rows: [
      ["⇧⌘G", "Go to path"],
      ["⌘↑ or ⌫", "Enclosing folder"],
      ["⌘↓ or ↩", "Open folder or link"],
      ["⇧⌘.", "Show or hide hidden files"],
      ["Space", "Select or deselect"],
      ["⇧↑ ⇧↓", "Extend the selection"],
      ["⌘-click", "Add to or remove from the selection"],
      ["⌘A", "Select all"],
      ["⌘C", "Copy selected paths"],
      ["Type a name", "Jump to a file"],
    ],
  },
  {
    title: "Window",
    rows: [
      ["⌃⌘S", "Show or hide the sidebar"],
      ["⌘,", "Settings"],
      ["⌘/", "Keyboard shortcuts"],
      ["⇧⌘W", "Close window"],
    ],
  },
];

/** Keyed by the caller per open, so a reopen during the exit motion gets a fresh drawer. */
export function ShortcutsDrawer({ onClose }: { onClose(): void }) {
  const close = useDrawerClose();
  return (
    <Drawer
      close={close}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Control and Option combinations without ⌘ always go to the shell."
      footer={<Button variant="outline" onClick={close.request}>Close</Button>}
    >
      {groups.map((group) => (
        <section key={group.title} className="flex flex-col gap-2">
          <h3 className="type-label">{group.title}</h3>
          <dl className="shortcut-list">
            {group.rows.map(([keys, action]) => (
              <div key={keys}>
                <dt>{action}</dt>
                <dd>
                  <kbd>{keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Drawer>
  );
}
