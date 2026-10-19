---
name: panelab
description: Check responsive layouts and cross-browser differences in real Chromium, WebKit, and Firefox with device emulation, then verify fixes. Use when building or fixing responsive UI, when a page breaks on a phone, tablet, or a specific browser, when asked to check mobile layout, overflow, Safari or Firefox rendering, or to screenshot a page on several devices.
---

# PaneLab

PaneLab renders one URL in real Chromium, WebKit (Safari-compatible), and Firefox pages with phone, tablet, laptop, and desktop emulation. Use it to see the page, find responsive problems, and prove that a fix works.

## Choose an interface

- **MCP tools** (`panelab` server): `open_preview`, `screenshot`, `scan_findings`, `inspect_element`, `act`, `reload`, `visual_diff`, `set_live_css`, `get_console` and `get_network` (filter with `query`, `types`, `errorsOnly`/`failedOnly`), `list_devices`.
- **CLI**: `panelab <command> <url> -d <device> -e <engines>`. Output is JSON when piped. Exit codes: 0 ok, 1 failed check, 2 usage, 3 engine or app unavailable.

If the PaneLab app is open with agent access on, both drive its **Agent** workspace so the user watches live. Otherwise they run headless previews that close when the command ends.

## Workflow

1. Start the project's dev server. PaneLab loads `localhost` URLs over HTTP.
2. Open a small, representative set: `iphone-16`, `pixel-7`, `ipad-air-11-m3`, `macbook-air-13`. Add engines to compare one device: `-d macbook-air-13 -e chromium,webkit,firefox`. Pin a device to one engine with `-d iphone-16@webkit`.
3. Look before changing anything: take screenshots and read the inline images.
4. Run `scan_findings` / `panelab scan`. It ranks horizontal overflow (with the outermost overflowing element), layout differences between engines at the same viewport, CSS an engine ignores, engine-only console and network errors, and mobile checks (viewport meta tag, tap targets under 24px, text under 12px, clipped text, and image resolution).
5. For each finding with an element, run `inspect_element` / `panelab inspect <url> '<selector>'`. Without `properties`, it returns only the computed styles that differ between previews.
6. Optionally try a fix with `set_live_css` before editing source. Live CSS never touches project files.
7. Capture a baseline before editing: `panelab diff <url> -d … --baseline .panelab/baseline` (missing baselines are saved).
8. Edit the source, then `reload` (or rerun the CLI) and compare against the baseline: `panelab diff <url> -d … --baseline .panelab/baseline`. Unchanged previews report `same`; `changed` includes a mismatch fraction, changed bounds, and a diff PNG path.
9. Rerun the scan to confirm the finding is gone.

## Interacting

`act` clicks, fills, presses, hovers, scrolls, or waits by CSS selector or visible text in every preview at once. Each preview reports `done`, `missing`, `ambiguous`, or `timeout`; ambiguous selectors are never guessed, so narrow them. No arbitrary JavaScript runs.

```sh
panelab act localhost:3000 click 'button[aria-label="Open menu"]' -d iphone-16 -d pixel-7
panelab act localhost:3000 fill '#email' 'person@example.com' -d iphone-16
```

## Devices and honesty

- Device ids match catalog ids, names, or aliases (`panelab devices --search pixel`).
- iOS devices default to WebKit; Android and desktops default to Chromium. Other pairs, such as an iPhone in Chromium or any phone in Firefox, need `--synthetic` / `synthetic: true`. They are emulations: report them as such.
- WebKit is Safari-compatible, not the Safari app. Emulation does not reproduce OS fonts, browser chrome, or hardware. Confirm OS-specific behavior on a physical device.
- Inspection covers the main frame; iframes appear as the `<iframe>` element. Cross-origin stylesheets cannot be read.

## Signed-in pages

Headless runs start signed out. Pass a Playwright storage state with `--storage-state auth.json`, or sign in once inside the app's Agent workspace with agent access on.

## Reporting

Name the device, engine, and CSS viewport for every issue, give the selector and the differing computed values, state the cause, and show the diff or scan result that proves the fix.
