---
name: PaneLab
description: Compact macOS controls around real browser comparisons.
colors:
  background: "#ffffff"
  foreground: "#222630"
  muted: "#f4f5f7"
  muted-foreground: "#606774"
  primary: "#0964d7"
  primary-foreground: "#ffffff"
  secondary: "#eaf0f8"
  accent: "#edf0f4"
  border: "#d9dde5"
  destructive: "#c6333a"
  rail: "#eff1f5"
  workspace: "#e5e8ee"
  preview-ground: "#f2f3f5"
  background-dark: "#20232a"
  foreground-dark: "#e6e9ef"
  muted-dark: "#292d36"
  muted-foreground-dark: "#a5adba"
  primary-dark: "#6ba6ff"
  primary-foreground-dark: "#101827"
  secondary-dark: "#303b50"
  accent-dark: "#30353f"
  border-dark: "#3b414c"
  destructive-dark: "#ff7b83"
  rail-dark: "#1c1f26"
  workspace-dark: "#15181e"
  preview-ground-dark: "#292d34"
  ready: "oklch(59.6% .145 163.225)"
  ready-dark: "oklch(76.5% .177 163.223)"
  warning: "oklch(55.5% .163 48.998)"
  warning-dark: "oklch(82.8% .189 84.429)"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Helvetica Neue\", sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: "28px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Helvetica Neue\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Helvetica Neue\", sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  pane-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Helvetica Neue\", sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
  metadata:
    fontFamily: "\"SF Mono\", Menlo, monospace"
    fontSize: "10px"
    fontWeight: 400
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Helvetica Neue\", sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
rounded:
  checkbox: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "1.5": "6px"
  "2.5": "10px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "#ffffff"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
    width: "100%"
  native-select:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "4px 32px 4px 12px"
    width: "100%"
  checkbox:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.checkbox}"
    size: "16px"
  library-row:
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
    width: "100%"
  pane-tile:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
  brand-mark:
    textColor: "{colors.primary}"
    size: "16px"
  brand-mark-startup:
    textColor: "{colors.primary}"
    size: "36px"
---

# Design System: PaneLab

## Overview

**Creative North Star: "PaneLab workspace"**

PaneLab workspace is a minimal macOS interface for daily comparison work. Clear porcelain and cool graphite surfaces make application controls easy to find while live website previews carry the visual weight. Blue identifies the selected preview, primary actions, and keyboard focus.

The interface uses the system sans family for controls and a system monospace stack for measurements, URLs, and request data. Compact controls, quiet separators, and restrained rounding keep repeated panes readable. Appearance follows macOS by default, with explicit light and dark overrides.

**Key Characteristics:**

- System typography and familiar compact controls.
- Porcelain and graphite theme pairs with blue selection.
- Flat workspace layers; shadows reserved for temporary overlays.
- Persistent engine and CSS viewport dimensions, with wrapping in narrow panes.
- Visible keyboard focus and reduced-motion support.

This records the implemented renderer in `src/renderer/styles.css`, `app.tsx`, the pane and inspector features, and the shared UI primitives. The frontmatter owns the token values.

## Colors

The palette pairs cool neutral layers with one blue action and selection accent. The frontmatter uses the exact CSS source values. Unsuffixed tokens are the light appearance; `-dark` tokens are the corresponding dark overrides.

### Primary

- **Selection blue** (`primary`, `primary-dark`): selected pane outlines, primary buttons, checked controls, caret, and focus rings.
- **Primary ink** (`primary-foreground`, `primary-foreground-dark`): text and icons on filled primary controls; white in light appearance and dark ink on the brighter dark-appearance blue.

### Neutral

- **Porcelain / graphite surface** (`background`): toolbar, preview header/footer, fields, popovers, dialogs, and inspector.
- **Interface ink** (`foreground`): ordinary copy and icons; also the inverted toast background.
- **Muted surface** (`muted`): subdued application regions and the startup surface.
- **Muted ink** (`muted-foreground`): engine labels, dimensions, placeholders, group labels, and diagnostic metadata.
- **Selected control surface** (`secondary`): active inspector controls, synchronization state, and selected requests. This is a tonal surface rather than a second brand accent.
- **Hover surface** (`accent`): ghost/outline button hover, library rows, and network rows.
- **Quiet separator** (`border`): field strokes, pane boundaries, and region separators. Lower-opacity variants soften titlebar and diagnostic dividers.
- **Rail surface** (`rail`): titlebar, left library, and status bar.
- **Workspace ground** (`workspace`): the region between preview tiles.
- **Preview ground** (`preview-ground`): the neutral content stage while a preview waits for a URL or a streamed frame.

### Status

- **Error red** (`destructive`): failed previews, invalid fields, destructive actions, and diagnostic errors.
- **Ready green** (`ready`): ready-state dots, paired with status text.
- **Warning amber** (`warning`): console warning text. The ready and warning values come from the emitted Tailwind theme used by the renderer; their dark counterparts follow the existing utilities.

**The Blue Selection Rule.** Use primary blue for selection, primary actions, and focus. Keep ordinary surfaces and device rows neutral.

## Typography

**Interface font:** -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif

**Data font:** "SF Mono", Menlo, monospace

Type is compact and familiar. Labels use sentence case; headings establish hierarchy through size and weight. There is no separate decorative display family.

### Hierarchy

- **Title:** the `title` role for dialog headings.
- **Body:** the `body` role for ordinary interface text and fields.
- **Control:** the `control` role for default buttons, with medium weight.
- **Label:** the `label` role for compact buttons, device names, and field labels.
- **Pane title:** the `pane-title` role for device identity in every preview header.
- **Metadata:** the `metadata` role for dimensions, timestamps, methods, counts, and related measurement data. General status copy at the same size remains sans-serif.

The shared address field uses the monospace family with label sizing. Diagnostic message content uses monospace with relaxed leading and wraps long text. Use ellipsis for secondary names and locations; retain complete engine and viewport identity by wrapping its separate groups.

**The System Type Rule.** Use the established system sans stack for interface copy and the monospace stack for URLs, measurements, and diagnostic evidence.

## Layout

The current workspace fills the application window. Its fixed-height titlebar (48px) and shared toolbar (56px) sit above a flexible body; a compact status bar (28px) closes the window. The left library is normally 240px wide. The comparison area takes the remaining width and height, scrolls independently, and gives live previews the largest share of the window.

Spacing follows the observed 4px base unit with half steps. Compact gaps use the smaller steps; region padding uses the larger steps. The preview region is an infinite canvas on the workspace ground with a 24px dot pattern at 30% muted-foreground. Frames are positioned freely in canvas pixels and snap to an 8px grid. A frame stores only its width (180–2400px); its website stage uses CSS `aspect-ratio` from the CSS viewport, and the header and 32px footer sit outside it. Arrange modes (single row, grid targeting 16:10 bounds, one row per engine) use 48px gaps. New previews join the canvas's right edge at the median canvas scale (canvas px per CSS px; 0.75 when empty). Arrange normalizes every frame to the selected frame's scale; rotation keeps scale. Canvas zoom ranges from 5% to 400%; Fit all uses 8% padding and never zooms above 100%. The width handle is a 16px target centered on the frame's lower-right corner, drawn as a 6px corner mark that appears on hover or selection. The canvas toolbar and overview map sit 12px from the lower corners on background surfaces with a 1px border; the overview map is 168×108px and appears from three previews.

At window widths up to 1050px, the library becomes 204px wide, toolbar spacing contracts, and optional toolbar labels and header Zoom to preview icons are hidden. The labeled Zoom to preview action remains inside Preview settings. Frames narrower than 210px also hide the header icon and use a 76px header, 8px inline padding, and tighter gaps; ordinary pane headers are 56px high. The settings action remains available. Engine and CSS viewport groups can wrap independently. The middle status explanation appears only from 1100px.

The bottom inspector starts at 288px high, has a 160px minimum and a 60vh maximum, and can resize vertically. Its tabs occupy 40px. Dialogs fit within the viewport with a 40px horizontal allowance and an 85vh height limit; the common dialog width caps at 560px. Popovers normally measure 320px with an 8px gap from the trigger.

## Elevation & Depth

The workspace uses tonal layers, separators, and outlines. Preview tiles have no ambient shadow. Their default outline is quiet; selection replaces it with primary blue and a thicker stroke. Transient overlays use soft shadows to make their relationship to the workspace clear.

### Shadow Vocabulary

- **Loading feedback:** the existing small utility shadow: `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)`.
- **Toast:** `0 6px 24px rgb(0 0 0 / 0.2)`.
- **Popover:** `0 8px 30px rgb(0 0 0 / 0.2)`.
- **Dialog:** `0 16px 60px rgb(0 0 0 / 0.25)`, over a black backdrop at 40% opacity.

**The Overlay Depth Rule.** Keep preview tiles flat. Use the documented shadows for popovers, dialogs, transient notices, and loading feedback.

## Shapes

Controls and rows use the medium radius; preview tiles, popovers, and dialogs use the larger surface radius. The toast uses the intermediate radius. Checkboxes have the smallest rounded corners, while status dots are circles.

Fields have a thin border. Preview tiles use an inset outline (1px normally, 2px selected, with a -1px offset) and clip content at their rounded edge. Streamed pages remain rectangular content inside a neutral stage; application chrome does not imitate physical device frames.

Icons are consistent outline SVGs, normally 16px in buttons. Smaller metadata icons use 12px or 14px. Keep stroke icons visually subordinate to labels and live page content.

The filled identity mark is three unequal rounded panes in a 24-unit viewbox: a tall left pane (9 × 20), a broad upper-right pane (9 × 12), and a small lower-right pane (6 × 6). They share 2-unit corner radii and gaps. The canonical geometry is [resources/panelab-mark.svg](resources/panelab-mark.svg).

## Components

### Brand Mark and Application Icon

The three-pane mark connects the native icon to the workspace. `BrandMark` uses the canonical SVG as an alpha mask on a decorative, `aria-hidden` span filled with `currentColor`. It uses theme primary at the documented titlebar and startup sizes beside the PaneLab name; the titlebar keeps its compact system typography.

The native master [resources/panelab.svg](resources/panelab.svg) places the white glyph on the existing light primary-blue tile. Its 1024px canvas has a 64px transparent outer margin, a square tile measuring 896px with a 200px corner radius, and glyph placement at `translate(224 224) scale(24)`. [scripts/generate-icons.ts](scripts/generate-icons.ts) renders PNG representations with installed Playwright Chromium and assembles ICNS with macOS `iconutil`. The PNG embeds Origin metadata; [resources/provenance.json](resources/provenance.json) records the source and export derivation, including ICNS provenance. The exported PNG supplies the Dock and About icon.

### Buttons

Compact, direct controls with a shared medium radius and medium weight. The default size is 36px high with 12px inline padding. Small controls are 28px high with 8px inline padding and label typography. Icon controls are 32px square; small icon controls are 28px square.

- **Primary:** blue fill and primary foreground; hover reduces the fill to 90% opacity.
- **Secondary:** the tonal selected-control fill; hover reduces it to 80% opacity.
- **Outline:** a background surface with a thin border; hover uses the neutral accent surface.
- **Ghost:** transparent at rest; hover uses the accent surface and ordinary foreground.
- **Destructive:** the available shared variant uses the error fill with white text and a 90% hover fill. Existing removal actions in menus use ghost buttons with error-colored text.

Keyboard focus uses a 2px primary ring with a 2px background-colored offset. Disabled buttons reduce opacity to 45% and suppress pointer interaction. Color state changes use the existing 150ms standard transition; there is no shared pressed-scale effect.

### Inputs / Fields

Fields share the 36px control height, medium radius, background surface, thin border, and 12px inline padding. Placeholder copy uses muted ink. Focus changes the border to blue and adds a 2px blue ring at 25% opacity. Invalid fields use an error-colored border; disabled fields reduce opacity to 50%.

The device search is a shorter field with a leading icon. Inspector filters use the shared field focus treatment even though their resting border and background are transparent. Native selects retain native selection behavior, use an inline chevron SVG, and leave trailing space for the indicator. Their focus ring uses blue at 30% opacity.

Checkboxes are compact square controls with a thin border. Checked state uses the primary fill and foreground checkmark. Focus is a blue ring at 40% opacity; disabled state is half opacity.

### Navigation

Device-library rows pair a muted category icon with a device-family name and monospace viewport dimensions labeled `CSS px`. A neutral hover fill and rounded corners make the full row recognizable as an action. The add icon appears on hover or focus within the row. These rows add previews; they do not represent a selected navigation page. Equivalent models share searchable aliases, and derived landscape variants stay out of the library.

Inspector controls use small secondary buttons for the active view and ghost buttons for the other view. Counts stay monospace and muted. Keyboard access and visible focus accompany icon-only toolbar and pane actions.

### Preview Tiles

A flat, rounded frame with a persistent device header, website stage at the CSS viewport aspect ratio, and 32px footer. Primary-blue selection follows the visible frame. The header keeps the engine and viewport dimensions labeled `CSS px`, using independent wrapping groups when space contracts. Display dimensions in Preview settings separates CSS viewport and screen measurements, pixel ratio, and native panel pixels. MacBook profiles identify their Retina 2× preset without claiming the macOS default scaled desktop resolution.

The footer combines a status dot with text for loading/readiness, synchronization exclusion or skipped action, and synthetic identity. Selection and status have distinct visual roles. Zoom to preview moves the camera to fit one preview; restoring returns the previous camera, and the layout never changes. Arrange previews and the ⇧1/⇧2/⇧0 shortcuts provide the keyboard path alongside pointer dragging. A dragged frame lifts with a deeper shadow.

### Engine Setup and Settings

The first-run screen uses the startup mark, system typography, and a single quiet surface with separated engine rows. Chromium and WebKit start checked; Firefox starts unchecked. Each row pairs a checkbox with a short engine description and a text status. Downloads start only from the explicit action. Continue becomes available when a selected engine is ready. The surface scrolls at short window heights without clipping the heading or actions.

Browser engines opens from workspace options or Settings (⌘,) in the existing dialog. The same rows show ready, queued, downloading, failed, and removal states. Disk use is reported per engine and as a total; shared support files are counted once. Disabled-engine rows offer Remove downloads. Errors remain beside the affected engine with a retry action. Busy engines lock their selection while work finishes. Paused preview tiles retain their dimensions and settings and link back to Browser engines.


### Overlays and Diagnostics

The inspector drawer tabs are Console, Network, Elements, Findings, and Live CSS. At the right of the tab bar, before the clear and close actions, per-preview views (Console, Network, Elements) show the inspected preview's host in monospace followed by a borderless native select of the inspected preview; changing it selects that preview on the canvas. Repeated device/engine pairs carry their canvas position. Workspace-wide views show "All previews". Filters accept whitespace-separated terms that must all match; a leading `-` excludes a term. Console level options show counts. Network adds a request-type chip row (Fetch/XHR, Doc, JS, CSS, Img, Font, Media, Socket, Other; only types present appear, click shows one, ⌘-click combines) and an Errors chip for failed and 4xx/5xx requests with a destructive count, plus Size and Time columns and a monospace summary line of visible requests and transferred bytes. Arrow keys move the selected request; Escape closes its details. Request details offer outline Copy URL, Copy as cURL, and Copy response actions, and pretty-print JSON payloads and bodies. Website-space highlights draw over each preview's stage in an SVG measured in CSS viewport pixels, so they stay aligned at any canvas zoom. Hover shows the box model in DevTools margin/border/padding/content tints with a dark monospace size label. The selection is a 2px primary outline with a primary label in every preview that resolves it. A centered status chip names a missing, ambiguous, or unavailable match, and an edge chip offers Reveal when the selection is scrolled out of view. Compare tints differing cells with a warning wash and separates viewport-size groups with a rule. Findings use error, warning, and muted info icons, and the severity filters show counts. The **Edited** chip in a pane footer opens Live CSS.

Popovers use background surfaces with 16px padding; dialogs use 24px padding and 20px gaps. Notices invert the normal foreground/background pair, include a status icon, and appear above the bottom bar. Diagnostic rows use quiet dividers, monospace evidence, and explicit error or warning color. Empty inspector states use a compact title and muted guidance.

Camera moves (fit, zoom, zoom to preview, reveal new preview) use 200ms transitions; dragging and resizing follow the pointer without transitions. The dialog backdrop uses a 150ms opacity transition. Reduced-motion preference reduces transition and animation durations to zero.

## Do's and Don'ts

### Do:

- **Do** keep real page previews visually dominant and retain compact application controls.
- **Do** apply corresponding light or dark values to every semantic role together.
- **Do** retain engine labels and CSS viewport dimensions when pane headers wrap.
- **Do** preserve the website's CSS viewport ratio and keep header and footer outside the website stage.
- **Do** keep selection outlines and keyboard focus visible.
- **Do** provide keyboard access to layout, maximize, and inspection controls.
- **Do** respect reduced motion and keep canvas motion limited to camera moves.

### Don't:

- **Don't** introduce decorative gradients or device-shell costumes.
- **Don't** replace system typography with a display font.
- **Don't** borrow colors or typography from the websites shown inside preview canvases.
- **Don't** add ambient shadows to resting preview tiles.
- **Don't** hide essential device identity to make narrow pane headers fit.
- **Don't** present native panel pixels as CSS viewport dimensions.




### Agents

**Workspace options → Agents and MCP** opens a dialog in the Browser engines pattern. It has three sections separated by quiet dividers:

- **Agent access:** an access checkbox with a short explanation, plus a status line built from a status dot and text.
- **Command-line tool:** a row with the shim path in monospace.
- **MCP clients:** one compact row per client. Each row shows the name, its config path in monospace metadata type, a text state, a copy icon button, and an outline **Add** button. Once the client is configured, **Add** becomes a ghost **Update** button.

While access is on, the titlebar shows a ghost chip before Workspace options. It reads **Agents on** with a neutral dot, or **Agent connected** with the ready dot. The chip stays neutral rather than blue, because blue is reserved for selection. Findings and Elements each have one ghost copy icon button that produces a Markdown brief for coding agents.
