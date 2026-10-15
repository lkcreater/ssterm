import {
  CircleCheckIcon,
  CopyIcon,
  ServerIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { ColorPair } from "./color-pair";
import { Section, Example } from "./section";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { signalTerminalTheme, terminalAnsiKeys } from "@/lib/terminal-theme";

const pairs = [
  ["Canvas", "background", "foreground"],
  ["Surface", "card", "card-foreground"],
  ["Elevated", "popover", "popover-foreground"],
  ["Primary action", "primary", "primary-foreground"],
  ["Secondary", "secondary", "secondary-foreground"],
  ["Muted metadata", "muted", "muted-foreground"],
  ["Selection", "accent", "accent-foreground"],
  ["Error", "background", "destructive"],
  ["Connected", "card", "connection-connected"],
  ["Attention / PROD", "card", "environment-production"],
  ["Essential boundary", "card", "interactive-boundary"],
  ["Sidebar", "sidebar", "sidebar-foreground"],
] as const;
const palette = [
  "background",
  "card",
  "popover",
  "primary",
  "foreground",
  "muted-foreground",
  "border",
  "input",
  "ring",
  "connection-connected",
  "connection-connecting",
  "connection-error",
  "connection-disconnected",
  "sidebar",
  "sidebar-accent",
];
const types = [
  ["type-title", "18 / 25.2 / 600", "Workspace title"],
  ["type-section", "15 / 22.5 / 500", "Server groups"],
  ["type-body", "13 / 19.5 / 400", "Connected with clarity. สวัสดีจาก ssterm"],
  ["type-label", "13 / 19.5 / 500", "Production servers"],
  ["type-caption", "12 / 18 / 400", "Last connected 2 minutes ago"],
  ["type-code", "12 / 18 / 400", "deploy@lab.ssterm.invalid:22"],
] as const;
export function Foundations() {
  return (
    <Section
      id="foundations"
      title="Foundations"
      description="Signal Blue · dark first · Inter, JetBrains Mono and Noto Sans Thai bundled offline. Live ratios below measure browser-resolved foreground / background pairs."
    >
      <div className="showcase-grid">
        {pairs.map(([name, background, foreground]) => (
          <ColorPair
            key={name}
            name={name}
            background={background}
            foreground={foreground}
          />
        ))}
      </div>
      <p className="fixture-caption">
        Structural border is deliberately subtle; it is not the sole boundary of
        an interactive field. Essential boundaries use the existing muted ink
        token. Ratios describe opaque pairs; rendered state combinations need
        their own checks.
      </p>
      <div className="grid grid-cols-5 gap-4">
        {palette.map((name) => (
          <div key={name} className="flex min-w-0 flex-col gap-2">
            <div
              className="palette-swatch"
              style={{ background: `var(--${name})` }}
            />
            <span className="type-code break-all">{name}</span>
          </div>
        ))}
      </div>
      <Example title="Typography">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              <TableHead>px / line height / weight</TableHead>
              <TableHead>Specimen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {types.map(([token, spec, copy]) => (
              <TableRow key={token}>
                <TableCell className="type-code">{token}</TableCell>
                <TableCell className="type-code">{spec}</TableCell>
                <TableCell>
                  <span className={token}>{copy}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="type-body">
          A quieter workspace keeps your execution target in view.
          ภาษาไทยยังอ่านได้ชัดเจน เมื่อชื่อเครื่องยาวมาก. Paths such as{" "}
          <code className="type-code">/srv/app/releases</code> use a separate
          monospace family.
        </p>
      </Example>
      <div className="showcase-grid">
        <Example title="4 px spacing grid">
          {[4, 8, 12, 16, 24, 32].map((size) => (
            <div className="flex items-center gap-4" key={size}>
              <span className="w-8 type-code">{size}</span>
              <div className="h-2 bg-primary" style={{ width: size * 5 }} />
            </div>
          ))}
        </Example>
        <Example title="Geometry & motion">
          <div className="flex flex-wrap gap-4">
            {[
              [4, "Accents"],
              [8, "Controls / rows"],
              [12, "Dialogs / cards"],
            ].map(([radius, label]) => (
              <div
                key={radius}
                className="flex size-24 items-center justify-center border bg-card p-3 text-center type-caption"
                style={{ borderRadius: radius }}
              >
                {radius}px
                <br />
                {label}
              </div>
            ))}
          </div>
          <p className="fixture-caption">
            32 px default controls and rows · 2 px solid focus outline. Quiet
            120 / 160 ms transitions. Reduced motion removes movement.
          </p>
        </Example>
        <Example title="Elevation & Lucide">
          <div className="flex gap-3">
            <div className="rounded-lg border bg-card p-3">Surface</div>
            <div className="rounded-lg bg-popover p-3 shadow-md">Popover</div>
          </div>
          <div className="flex gap-5">
            {[
              ServerIcon,
              TerminalIcon,
              CopyIcon,
              CircleCheckIcon,
              TriangleAlertIcon,
            ].map((Icon, index) => (
              <Icon key={index} className="size-4" aria-hidden="true" />
            ))}
          </div>
        </Example>
      </div>
      <Example title="Independent terminal ANSI 16">
        <div
          className="grid grid-cols-8 gap-2"
          style={{ background: signalTerminalTheme.background, padding: 12 }}
        >
          {terminalAnsiKeys.map((key) => (
            <span
              key={key}
              className="type-code break-all"
              style={{ color: signalTerminalTheme[key] }}
            >
              {key}
              <br />
              Aa 09
            </span>
          ))}
        </div>
        <p className="fixture-caption">
          Terminal output owns its foreground, background, cursor, selection and
          ANSI colors. Application theme utilities do not recolor its content.
        </p>
      </Example>
    </Section>
  );
}
