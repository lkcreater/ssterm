# ssterm — Design System

> **Version:** 1.0\
> **Brand direction:** 02 — Signal Blue\
> **Platform:** macOS desktop (Electron + React + TypeScript)\
> **UI stack:** Tailwind CSS + shadcn/ui\
> **Theme strategy:** Dark-first, light-ready\
> **Brand line:** Connected with clarity.

> **Implementation status:** `AWAITING_IMPLEMENT_CONFIRMATION` — specification for planning; application code and visual assets have not been implemented. See the [implementation plan](design-system-implementation.md).

## 1. Product & design principles

**ssterm** is a local-first SSH workspace for developers, DevOps engineers, and system administrators. It combines server organization, multi-session terminals, SFTP, snippets, credentials, and SSH tunnels without requiring an account.

**Brand personality:** focused, precise, reliable, modern, approachable.

**Visual concept — Signal Blue:** deep-navy surfaces with restrained electric-blue accents. Blue means **user focus, selection, and action**, not connectivity. Operational states use separate, consistent status colors.

1. **Terminal first.** Protect terminal space; navigation and auxiliary tools are collapsible or resizable.
2. **Always know the target.** Display server identity, environment, user/host, and connection state wherever a command can be issued.
3. **Density with clarity.** Support many connections and tabs without forcing oversized cards or dense, indistinguishable text.
4. **State is explicit.** Do not encode focus, connection health, and production risk with the same color.
5. **Safe by design.** Credentials, file transfers, destructive actions, and tunnel exposure need transparent feedback and appropriate confirmation.
6. **Quiet motion.** Transitions help orient, never distract from typing or reading output.

## 2. Brand identity

### 2.1 Logo direction

- **Current artwork:** use the supplied **SST-style monogram** in [brand-logo.png](../logo/brand-logo.png) and [icon-logo.png](../logo/icon-logo.png), replacing the earlier conceptual Connected S direction. Preserve the supplied geometry and cyan-to-blue treatment.
- **Wordmark:** lowercase `ssterm` as shown in the brand lockup. The original wordmark font is unverified; application UI typography remains Inter independently.
- **App icon:** use [icon-logo.png](../logo/icon-logo.png) as the source artwork reference: navy rounded-square tile, blue–cyan monogram and edge lighting. [design-logo.png](../logo/design-logo.png) is the presentation reference with baked-in background and lighting.
- **Small-size rule:** validate monogram legibility, alpha edges, safe-area padding and lighting at 16, 32, 64, 128, 256, 512, and 1024 px before production export; a simplified variant requires artwork review.
- **Treatment boundary:** gradients and lighting belong to the supplied brand artwork. Product controls keep restrained semantic styling and separate operational state colors.
- **Avoid:** stretching/redrawing the mark without review, substituting generic padlock/key/`>_` symbols, and using the logo treatment as a connection-status indicator.

Asset dimensions, alpha-channel metadata, usage rules and pending packaging work are recorded in [Logo & app icon handoff](../logo/README.md). These PNG references are available; production exports and visual QA remain pending implementation confirmation.

### 2.2 Brand voice

Concise, calm, and actionable. Say **“Connection lost. Reconnect”** rather than **“Something went wrong!”**. Name the affected server and an available next step. Never imply that an unverified operation succeeded.

## 3. Color system

### 3.1 Dark theme — primary palette

| Semantic role | Hex | Usage |
|---|---|---|
| Background | `#0C1220` | Main canvas, terminal default background |
| Surface / Card | `#172235` | Sidebar, tab bar, panels, dialogs |
| Elevated / Selected | `#243650` | Selected rows, active surfaces, hover emphasis |
| Brand primary | `#6A9FFF` | Primary actions, active tabs, focused elements |
| Foreground | `#E5EDFA` | Primary UI text |
| Muted foreground | `#91A4C1` | Metadata, secondary labels |
| Border / Input | `#2B3D59` | Dividers and control outlines |
| Focus ring | `#6A9FFF` | Visible keyboard focus |

### 3.2 Operational & risk colors

| State | Hex | Meaning | Pair with |
|---|---|---|---|
| Connected / Success | `#62BD8A` | SSH/SFTP connection healthy | Circle-check + “Connected” |
| Connecting / Warning | `#E5B765` | In progress, attention needed | Spinner + “Connecting” |
| Failed / Destructive | `#E87979` | Error or destructive action | Alert icon + explanation |
| Disconnected / Inactive | `#7087AA` | Not connected | Circle + “Disconnected” |
| Brand / Active focus | `#6A9FFF` | User selection or current workspace | Accent edge / focus ring |

**Important:** A connected server is green even when its tab is not active. The **active tab** is blue regardless of connection state. Use icon and text alongside color. Mark production environments explicitly with a `PROD` text label; do not rely on red alone.

### 3.3 Light theme — proposed complementary palette

These are *proposed tokens* for a later light theme, not a requirement for the first macOS release.

| Role | Hex |
|---|---|
| Background | `#F6F8FC` |
| Surface / Card | `#FFFFFF` |
| Elevated / Selected | `#EAF0FA` |
| Primary | `#285FD1` |
| Foreground | `#16243B` |
| Muted foreground | `#596B85` |
| Border / Input | `#D5DEED` |
| Focus ring | `#285FD1` |

### 3.4 Terminal theme vs application theme

Terminal foreground, background, cursor, ANSI 16 colors, and selection colors must be independently configurable from the application theme. Preserve ANSI color semantics and test legibility on the terminal background; never force application CSS text colors over terminal output.

## 4. Typography

| Context | Family | Default | Guidance |
|---|---|---|---|
| App UI | Inter, system-ui, sans-serif | 13–14 px | Labels, navigation, forms, settings |
| Terminal | JetBrains Mono, ui-monospace, monospace | 13–14 px | User-adjustable font size and line-height |
| Code, paths, IP, snippets | JetBrains Mono, ui-monospace, monospace | 12–13 px | Use tabular numerals when available |
| Section headings | Inter | 15–18 px | Medium/semibold only as needed |
| Fine metadata | Inter | 11–12 px | Avoid for critical status or actions |

- Weight: Regular 400, Medium 500, Semibold 600. Avoid heavy bold everywhere.
- Default UI line-height: approximately 1.4–1.5; terminal line-height approximately 1.25–1.4, adjustable.
- Use truncation for long hosts/paths, but expose the entire value via tooltip and copy affordance.
- Do not use ambiguous icon-only controls without accessible labels/tooltips.

## 5. Shape, spacing & elevation

- **Base spacing:** 4 px grid; preferred increments 4, 8, 12, 16, 24, 32.
- **Control heights:** compact 28–32 px; comfortable 36–40 px.
- **Row heights:** compact 30–34 px, depending on density and font size.
- **Corner radius:** 6–8 px for controls/rows; 10–12 px for dialogs; icon artwork follows macOS icon conventions.
- **Border:** 1 px, subtle (`--border`). Prefer restrained borders and surface differences over heavy shadows.
- **Panel dividers:** draggable 1 px boundary with a larger effective hit target.
- **Motion:** 120–180 ms for hover, selection, and panel transitions; no animated terminal output or distracting backgrounds. Honor reduced-motion preferences.

## 6. Layout architecture

```text
┌───────────────────────── macOS title/toolbar ─────────────────────────┐
│ Sidebar: Servers       │  Tabs: prod-api-01 | prod-db-01 | staging  │
│  - Groups/tags/search  ├─────────────────────────────────────────────┤
│  - Connection state    │  Terminal pane A   │  Terminal pane B      │
│  - Quick connect       │                    │                       │
│                       │                    │                       │
│                       ├────────────────────┴───────────────────────┤
│                       │  Context/status: host · user · env · SSH     │
└───────────────────────┴─────────────────────────────────────────────┘
```

### 6.1 Primary shell

- **macOS titlebar:** respect traffic-light controls and drag regions; do not place interactive actions under them.
- **Server sidebar:** group, tag, favorites, search, connected state; width resizable and collapsible.
- **Session tabs:** clear active indicator, short target name, unsaved/busy information where needed, close affordance; support many tabs with overflow handling.
- **Split panes:** visible focus indicator for the pane receiving keyboard input; each pane retains its own target and connection status.
- **Status/context bar:** show server name, hostname/IP, username, environment, connection protocol/state; provide copy full target.
- **Auxiliary panels:** SFTP, snippets, tunnels, and settings should not permanently shrink the terminal by default.

### 6.2 Connection display pattern

Every actionable terminal pane should surface:

`[Connection icon + state] [server display name] [environment] [user@host:port]`

For example: `● Connected · prod-api-01 · PROD · ubuntu@10.0.1.25:22`.

### 6.3 SFTP

- Two-column local ↔ remote layout with clearly labeled roots.
- Show full or breadcrumb path, file name, size, modified date, and transfer direction.
- Surface queue, throughput, progress, completed/failed counts, retry, cancel, and conflict choices.
- For overwrite, show source and destination clearly; make conflict handling explicit.

### 6.4 Credentials

- Show credential **labels and type**, never passwords or private key contents in default lists.
- Differentiate `password`, `SSH key`, and `agent` authentication visually and textually.
- Indicate reuse across hosts and warn before destructive changes to shared credentials.
- Never log secrets, paste secrets into UI notifications, or reveal them by default.

### 6.5 Snippets & tunnels

- **Snippets:** searchable title, command preview, tags, and optional dangerous-command confirmation; make the execution target explicit before running.
- **Tunnels:** show local/remote/dynamic type, bind address, port, destination, running state, and errors. Warn when binding to a publicly reachable interface.

## 7. Component specifications

| Component | Default | Hover | Selected / Active | Disabled / Error |
|---|---|---|---|---|
| Button | Surface or primary fill | Subtle brightness/surface change | Pressed feedback | Reduced emphasis; error uses destructive token |
| Sidebar row | Transparent | Elevated surface | Elevated + blue edge/indicator | Muted text |
| Session tab | Surface | Elevated | Blue indicator + stronger foreground | Disconnected shown independently |
| Input / Search | Surface with border | Border emphasis | Blue focus ring | Error text + icon |
| Tree item | Compact with indent | Row highlight | Blue selection cue | Muted / unavailable |
| Connection badge | Icon + label | — | Independent of tab selection | State-specific icon + label |
| Dialog | Elevated surface | — | Focused primary action | Destructive copy and confirmation |
| Toast | Compact, actionable | — | — | Success/warning/error icon + text |
| Transfer row | File + direction + progress | Highlight | Details on selection | Retry/cancel affordances |

**Keyboard accessibility:** Every actionable control must have visible focus state. Blue focus outlines should differ from persistent selection styling. Maintain sensible tab order and macOS-appropriate shortcuts; provide a shortcut reference screen.

**Contrast:** Target WCAG AA: 4.5:1 for normal text, 3:1 for large text and essential UI graphics. Validate actual rendered combinations, especially muted labels and blue text on dark surfaces; palette selection alone does not guarantee contrast.

## 8. Empty, loading, and error states

- **No servers:** “No servers yet” + “Add server” action; describe import as a secondary option if supported.
- **Connecting:** show spinner and server name; allow cancellation where supported.
- **Connection lost:** retain terminal history, visibly change status, offer Reconnect.
- **Host key changed:** high-salience security warning with fingerprint comparison and deliberate decision. Never silently accept changed fingerprints.
- **Authentication failed:** explain which host failed; do not expose credentials.
- **SFTP conflict:** explicitly present replace/skip/rename choices and destination path.
- **Tunnel bind failed:** show port/address and likely resolution; do not claim tunnel started.

## 9. Tailwind / shadcn/ui tokens

The values below assume a shadcn/ui configuration that accepts CSS variables as direct color values (e.g., Tailwind v4). For a Tailwind v3 setup using HSL channel variables, adapt the token format instead of mixing incompatible syntaxes.

```css
/* src/styles/globals.css — dark-first semantic tokens */
:root,
.dark {
  color-scheme: dark;
  --background: #0c1220;
  --foreground: #e5edfa;
  --card: #172235;
  --card-foreground: #e5edfa;
  --popover: #243650;
  --popover-foreground: #e5edfa;
  --primary: #6a9fff;
  --primary-foreground: #0c1220;
  --secondary: #243650;
  --secondary-foreground: #e5edfa;
  --muted: #172235;
  --muted-foreground: #91a4c1;
  --accent: #243650;
  --accent-foreground: #e5edfa;
  --destructive: #e87979;
  --border: #2b3d59;
  --input: #2b3d59;
  --ring: #6a9fff;
  --radius: 0.5rem;

  --connection-connected: #62bd8a;
  --connection-connecting: #e5b765;
  --connection-error: #e87979;
  --connection-disconnected: #7087aa;
  --environment-production: #e5b765;
}

.light {
  color-scheme: light;
  --background: #f6f8fc;
  --foreground: #16243b;
  --card: #ffffff;
  --card-foreground: #16243b;
  --popover: #ffffff;
  --popover-foreground: #16243b;
  --primary: #285fd1;
  --primary-foreground: #ffffff;
  --secondary: #eaf0fa;
  --secondary-foreground: #16243b;
  --muted: #eaf0fa;
  --muted-foreground: #596b85;
  --accent: #eaf0fa;
  --accent-foreground: #16243b;
  --destructive: #b5323c;
  --border: #d5deed;
  --input: #d5deed;
  --ring: #285fd1;
}
```

Example component variant:

```tsx
import { cn } from "@/lib/utils";

type ConnectionState = "connected" | "connecting" | "error" | "disconnected";

const labels: Record<ConnectionState, string> = {
  connected: "Connected",
  connecting: "Connecting",
  error: "Connection error",
  disconnected: "Disconnected",
};

export function ConnectionStatus({ state }: { state: ConnectionState }) {
  const colors: Record<ConnectionState, string> = {
    connected: "var(--connection-connected)",
    connecting: "var(--connection-connecting)",
    error: "var(--connection-error)",
    disconnected: "var(--connection-disconnected)",
  };

  return (
    <span className={cn("inline-flex items-center gap-2 text-xs text-foreground")}
      role="status" aria-label={labels[state]}>
      <span aria-hidden="true" className="size-2 rounded-full"
        style={{ backgroundColor: colors[state] }} />
      {labels[state]}
    </span>
  );
}
```

Use state text and icons, not a colored dot alone. For frequently updated status lists, avoid unnecessarily announcing every update to screen readers; tune live-region behavior by context.

## 10. Suggested code organization

```text
src/
  components/
    ui/                  # shadcn/ui primitives
    connection/          # status, host identity, badges
    server-tree/         # groups, tags, search
    terminal/            # tabs, panes, context bar
    sftp/                # dual-pane browser, transfer queue
    snippets/            # library, editor, execution
    tunnels/             # listings, status, editor
  styles/
    globals.css
    terminal-themes.css
  features/
    preferences/
    credentials/
  lib/
    design-tokens.ts     # optional typed semantic mappings
```

## 11. Release quality checklist

- [ ] Active tab and connected state are distinguishable at a glance.
- [ ] Each split pane identifies its command execution target.
- [ ] Production hosts are explicitly labeled.
- [ ] Long hostnames, paths, and file names are accessible in full.
- [ ] Terminal remains readable under high-output and multi-pane conditions.
- [ ] All actions have visible keyboard focus; shortcuts do not hijack terminal input unexpectedly.
- [ ] Connection, transfer, tunnel, and credential errors are specific and actionable.
- [ ] Secrets are hidden by default and excluded from telemetry/logging.
- [ ] Destructive actions identify the exact host/file/resource before confirmation.
- [ ] Layout is usable at common macOS laptop window sizes and supports resize/collapse.
- [ ] Text and essential indicators pass contrast checks.
- [ ] Reduced motion, system scaling, and theme preferences are respected.
- [ ] App icon remains recognizable at Dock and Finder sizes.

## 12. Decisions to keep consistent

**Locked:** Signal Blue; deep navy + electric blue; dark-first; Inter + JetBrains Mono; terminal-first composition; blue for focus; separate colors for operational status. Current logo/icon references are the supplied SST-style artwork in [docs/logo](../logo/README.md).

**Preparation still open:** production logo/icon exports, small-size optical adjustments and alpha/padding validation; detailed light theme validation; terminal ANSI palette; density preference defaults; macOS native titlebar treatment. The wordmark font and vector/transparent lockup variants have not been supplied.

## 13. Implementation handoff

- Use [design-system-implementation.md](design-system-implementation.md) for token mappings, component inventory, acceptance checks, open decisions, and the DS01–DS06 sequence.
- Foundation work belongs to SST-001/004, product composition to SST-018, visual/accessibility acceptance to SST-027, and font/icon packaging to SST-028 in [tickets.md](tickets.md). Work items T047–T052 are tracked in [tasks.md](tasks.md).
- Dark theme is the first-release target; light theme and feature patterns outside the agreed MVP remain later scope.
- CSS/TSX snippets above illustrate design intent. Production code must complete the Tailwind/shadcn mappings, accessibility checks, and app/terminal theme separation before acceptance.
- Wait for user confirmation before starting implementation. This document update does not authorize app scaffolding, dependency installation, or visual asset generation.

---

*ssterm — A calmer way to control connected systems.*
