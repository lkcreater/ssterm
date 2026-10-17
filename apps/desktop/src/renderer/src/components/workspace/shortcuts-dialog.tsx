import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
      ["⌘C", "Copy selection"],
      ["⌘V", "Paste"],
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

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100%-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Control and Option combinations without ⌘ always go to the shell.</DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  );
}
