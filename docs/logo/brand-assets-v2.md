# ssterm — Standalone Charcoal assets v2

Created on 2026-10-22 with built-in `image_gen` from the existing logo/icon and the approved Charcoal direction. Original source artwork remains unchanged.

- [Brand lockup v2](brand-logo-v2.png): existing SST identity and lowercase wordmark on neutral charcoal.
- [App icon concept v2](icon-logo-v2.png): existing SST identity on a charcoal rounded-square tile; transparent exterior requested and checked separately.
- [UI v2 gallery](ui-v2/gallery.html)

Verified files: brand lockup **1536×1024 RGB PNG**; icon **1254×1254 RGBA PNG**, all four exterior corners alpha 0 and alpha range 0–255. The icon also contains semi-transparent pixels, so opacity and edge treatment still need production export review.

These PNGs are design reference assets. They are not vector masters or verified production `.icns` exports. Generative artwork does not guarantee pixel-identical source geometry. Wordmark font identification, small-size legibility, alpha-edge cleanup and native Dock/Finder packaging remain separate export checks. The app's installed/runtime icon has not been replaced.

## Prompts

### brand-logo-v2

Transparent background requested: `false`.

```text
Use case: precise-object-edit. Asset type: standalone ssterm brand lockup v2. Input 1 is the authoritative ORIGINAL SST logo and lowercase ssterm wordmark. Input 2 is the approved neutral charcoal brand direction. Produce ONLY a clean standalone brand lockup on a perfectly uniform matte charcoal #1E1E1E canvas, landscape 1536x1024. Preserve the original SST monogram silhouette, interlocking ribbon structure, exact cut angles, cyan to electric blue gradient and original lowercase ssterm wordmark letterforms and proportions. Main original monogram centered above original white ssterm wordmark, like original reference; generous negative space and at least 20 percent safe margins, centered as one balanced lockup. Change only the original navy backdrop and ambient blue lighting to solid neutral charcoal, and make the white wordmark clean and flat rather than metallic. No new logo, no redesigned lettering, no added tagline, no text 'v2', no UI, no board, no extra panels, no border, no texture, no glow, no reflections or 3D. The brand identity is unchanged; the canvas and presentation now match Charcoal v2. Crisp artwork edges.
```

### icon-logo-v2

Transparent background requested: `true`.

```text
Use case: precise-object-edit. Asset type: standalone ssterm app icon v2, PNG with transparent outside area. Input 1 is the authoritative EXISTING SST app icon. Input 2 is the approved Charcoal v2 direction. Produce one square 1024x1024 icon asset. Preserve the original distinctive SST monogram silhouette exactly, interlocking ribbons, cut angles, proportions and cyan-to-electric-blue gradient. Preserve the original rounded-square tile proportions and generous monogram internal padding. Change the tile from saturated navy and neon glass to a refined matte neutral-charcoal #252525 rounded-square, thin restrained #383838 edge, soft subtle neutral bevel at most. Remove all original blue glow, neon blue rim, reflections and glass sheen; keep original logo gradient as the only vivid color. Center icon tile with about 8 percent transparent margin around tile on all sides; genuine fully transparent exterior outside the rounded-square tile, not black or white backdrop, no drawn checkerboard. Inside tile is opaque charcoal. The SST mark should be large, clear, centered and legible, with at least 16 percent internal padding. No wordmark, no letters beyond the EXISTING SST symbol, no new logo design, no wallpaper, no pedestal, no decorative scene, no text v2. Crisp clean alpha edges. One finished icon.
```

