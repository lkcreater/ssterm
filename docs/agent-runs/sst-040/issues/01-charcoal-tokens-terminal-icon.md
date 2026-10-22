# 01: Charcoal tokens, terminal palette and icon v2

**What to build:** Every screen renders on the v2 charcoal tokens, terminals use the independent Charcoal palette, and the packaged app plus in-app icon use icon v2. This is the visual base every later ticket builds on.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Semantic tokens take the v2 values (canvas, sidebar, surface/drawer, field, line, text, secondary text, primary blue with white text); components keep using semantic tokens only
- [ ] Status colors (connected/connecting/error/disconnected, PROD, destructive text) are re-tuned for charcoal and measure ≥4.5:1 as text
- [ ] Primary blue is used for focus ring, selection outline and blue text, and the line color for control boundaries, per the ADR 0008 exception; tests attach the measured ratios for these roles instead of asserting the old bar
- [ ] Terminal palette is Charcoal (background #131313, foreground/cursor #F3F3F3, green #22C55E, blue #3B82F6, neutral black #737373, primary-blue selection at partial alpha), still independent of app tokens; the persisted terminal palette setting value is unchanged
- [ ] The icon build derives from icon v2 and its alpha/padding QA output is produced; the in-app icon is a copy of icon v2; original artwork is untouched
- [ ] Development showcase shows v2 color specimens and contrast pairs
- [ ] typecheck, unit, build and E2E pass; packaged icon check confirms icon v2
