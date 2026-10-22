# Using PaneLab

- [Browser engines](#browser-engines)
- [Opening a site](#opening-a-site)
- [Devices](#devices)
- [The canvas](#the-canvas)
- [Synchronization](#synchronization)
- [Per-pane tools](#per-pane-tools)
- [Inspector](#inspector)
- [Workspaces and sessions](#workspaces-and-sessions)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Emulation limits](#emulation-limits)
- [Data and privacy](#data-and-privacy)
- [Troubleshooting](#troubleshooting)

## Browser engines

The first launch asks which engines to download. Chromium and WebKit start checked and Firefox doesn't. Nothing downloads until you select **Download selected engines**, and you can continue once one selected engine is ready while the rest finish in the background.

Change engines later in **Settings… (⌘,) → Browser engines**, or from **Workspace options → Browser engines**. Turning an engine off pauses its previews but keeps its files and sessions. Settings shows disk use per engine and in total, and **Remove downloads** deletes a disabled engine's files without touching workspaces or sign-ins.

PaneLab keeps its browsers in `browsers/` inside its data folder and only downloads pinned builds you selected. It ignores Playwright's shared cache and never downloads at startup. If a build is missing after an upgrade or an interrupted download, the engine row offers a retry. For Chromium it downloads only Playwright's headless shell.

WebKit is the engine behind Safari, not the Safari app itself.

## Opening a site

Type `localhost:3000`, any HTTP or HTTPS address, or a local file (`file:///Users/you/site/index.html` or just `/Users/you/site/index.html`) into the shared address bar. `localhost` and `*.localhost` default to HTTP, and other bare hosts default to HTTPS. Navigation and reload from the address bar reach every pane, including panes excluded from synchronization. Opening a new address while a page is still loading replaces that load right away.

The address bar shows the selected pane's location; clicking into it selects the whole address. An address you are editing stays put until you open it or press Escape. Back and forward move the selected pane through its own history, or every participating pane while navigation is synchronized. They're disabled when the engine reports no history in that direction, and stay enabled when the engine can't tell (no Navigation API, or cross-origin entries it can't see).

## Devices

Pick devices in the sidebar to add previews. The library has 34 curated device and screen-size families from [`device-catalog.json`](../src/shared/device-catalog.json), including five MacBook sizes and seven iPads. Search also matches equivalent models listed as aliases. Rotate a phone or tablet to get its landscape variant, or rotate every phone and tablet at once with **Rotate phones and tablets** in the canvas toolbar (`⌘⌥R`). Desktops rotate only from their own preview settings, which creates a custom portrait profile.

**Preview settings → Media features** emulates a dark color scheme, reduced motion, more contrast, and forced colors for one preview. Changes apply live without reloading, and the preview footer names what's active. **Workspace options → Website languages** sets the languages every preview sends in `Accept-Language` and reports as `navigator.language`, preferred first (for example `de-DE, en`). Changing languages reloads every preview and keeps the signed-in session.

Each pane gets its own browser context with the device's viewport, screen size, pixel ratio, mobile and touch settings, user agent, and platform. iOS devices default to WebKit and Android devices to Chromium. Desktop profiles work in all three engines.

Pairs that no real device ships with, such as an iPhone in Chromium or any phone in Firefox, need synthetic emulation. You opt in per pane, and the pane is labeled as synthetic.

Sizes in headers and the library are CSS pixels, the numbers your breakpoints see. **Preview settings → Display dimensions** lists CSS viewport and screen size, pixel ratio, and the native panel pixels separately. Built-in viewports use the full logical screen without subtracting browser toolbars. MacBook profiles use an explicit Retina 2× full-screen preset (native pixels divided by two), not macOS's default scaled resolution.

Device data was researched on October 14, 2026 from Apple, Google, and Samsung specifications, with Playwright's descriptors for browser identities. StatCounter screen-resolution data and Counterpoint sales reports guided which families to include. Neither source can measure what share of real users the catalog covers, so PaneLab doesn't claim a coverage number.

Custom devices let you set viewport and screen size, pixel ratio, orientation, touch and mobile flags, and per-engine identity overrides. If a catalog update removes a device that a workspace still uses, PaneLab keeps it as a custom profile.

## The canvas

Previews sit on a free canvas. Drag a preview by its header to move it; other previews stay where they are, and positions snap to an 8px grid. Drag the lower-right corner to resize. Height follows the site's aspect ratio and the emulated viewport doesn't change.

Scroll over empty canvas, or hold Space and drag, to pan. Pinch, ⌘-scroll, or `⌘=` / `⌘−` to zoom, and `⌘0` for 100%. Scrolling over a preview scrolls the website.

The toolbar in the lower right has zoom controls, **Fit all previews**, and **Arrange previews**: one row, a grid, or one row per engine. Arranging also gives every preview the selected preview's scale so sizes compare honestly. **Zoom to preview** (header button, double-click the header, or Preview settings) fits one preview to the window without moving anything, and Escape returns to the previous view.

There's no pane limit. Four to eight active previews is the intended range.

## Synchronization

Synchronization starts off. Turn it on from the toolbar and pick which actions to mirror: navigation, reload, clicks, typing, and scrolling. Exclude a pane from its settings menu.

Clicks and typing find the same element in every pane by test id, id, name, label, text, then structural path. A text field matches across `<input>` and `<textarea>`, since sites sometimes serve one engine each. Scrolling uses relative positions. When a pane can't find a unique match, it skips the action and says so in its footer.

Typing reaches other panes as the text it produces. Escape and Enter are mirrored too, so dialogs close and forms submit everywhere; Enter inside a multi-line field arrives as a newline instead. Outside text fields, Space, arrow keys, Home, End, Page Up, and Page Down are mirrored for listboxes, sliders, and carousels. Tab and shortcuts with Command, Control, or Option are not, because focus order and shortcuts differ between layouts and engines.

Clicks also mirror HTML drag and drop. Drag libraries that move elements with pointer events instead aren't captured.

When a click, Enter, or drop navigates the source pane within five seconds, for example a search that fetches results first, panes that couldn't repeat it load the new address instead. A pane that already got there stays put.

Headless engines don't draw native dropdowns, so clicking a `<select>` opens PaneLab's own list over the preview. Choose with the pointer or arrow keys, Enter, and typeahead; Escape closes it. Arrow keys on a focused dropdown step through its options. Date, time, and color pickers, `<datalist>` suggestions, and dropdowns inside frames have no PaneLab picker; list-style selects (`multiple` or `size` above 1) work directly.

## Per-pane tools

Each pane's menu has its own navigation, history, reload, viewport or full-page PNG capture, and a way back from popups. Website alerts and prompts appear in PaneLab. Uploads and downloads use native macOS file dialogs. The camera button in the toolbar captures every preview into a folder.

## Inspector

The drawer below the canvas has five tabs.

**Console** shows logs and JavaScript exceptions for the selected preview. **Network** shows requests with status, timing, headers, payloads, failures, and text response bodies. Each pane keeps up to 1,000 entries, and bodies are shown up to 1 MiB. A body can disappear after a navigation, redirect, or cancellation. PaneLab observes traffic and never reroutes it or disables caching.

**Elements** works across every preview. Press `⌘⇧C`, hover any preview to see its box model, and click to select. PaneLab finds the same element in the other previews with the matching rules synchronization uses, and outlines it in each. A preview where the match is missing or ambiguous says so. *This preview* shows a lazy DOM tree you can navigate by keyboard, the box model, matched rules from same-origin stylesheets (with `@media` and `@supports` evaluated), and computed styles. *Compare previews* lines up the element's box and computed values side by side and tints values that differ.

**Findings** scans every preview (up to 4,000 elements per page) and ranks what it finds:

- Horizontal overflow, pointing at the outermost element that sticks out past the viewport while its container fits.
- Differences between engines at the same viewport size: the top-most width difference, the deepest height difference, elements missing or hidden in one engine, unsupported properties, and dropped stylesheet rules.
- Console errors and failing requests that show up in only one engine.
- Mobile problems: no viewport meta tag, clipped text, tap targets under 24px, text under 12px, and images with the wrong resolution for their display size.

Click a finding to select its element in every preview. Navigating marks results stale.

**Live CSS** applies the CSS you type to every preview through one constructed stylesheet. It survives reloads and navigation until you quit or switch workspaces, and you can toggle it off to compare. Declarations an engine ignores are listed per preview. Editing a value in Elements either sets an inline style (the default) or adds an `!important` rule here; pick under **Settings → General → Style edits**. CSS an agent applies shows up in the editor too. PaneLab never writes to your project files.

Inspection covers the main frame. An iframe is inspected as the `<iframe>` element, and cross-origin stylesheets can't be read from the page.

## Workspaces and sessions

Create named workspaces from the title bar. Each one saves its URL, devices, canvas layout, and sync settings. Device presets save a set of devices and their layout for reuse. Deleting a workspace asks first, since it also removes the workspace's saved sign-ins.

All previews in a workspace share one website session across engines. Sign in once and every preview is signed in. Cookies and localStorage sync live, within about two seconds. IndexedDB is captured when the session is saved and restored when a preview's context is created, with the most recently used preview winning. SessionStorage, the HTTP cache, and full browser profiles aren't kept. Captcha and bot-check state stays in the engine that created it, because another engine replaying it fails verification: reCAPTCHA (`_GRECAPTCHA`, Google's `rc::` keys), Cloudflare challenges and Turnstile (`cf_clearance`, `__cf_bm`, `cf.turnstile.` keys), AWS WAF (`aws-waf-token`), and DataDome (`datadome`). Solve a captcha in the preview you sign in from; each other preview passes its own check if the site asks again.

Sessions are saved every 30 seconds, on workspace switches, and on quit. **Workspace options → Reset website sessions…** signs every preview out and clears the saved session.

## Screenshots

**Capture all previews** in the toolbar and `⌘⇧S` (selected preview) ask where to save. Choose a folder under **Settings → General → Screenshots** to save there directly; files are named by device, engine, and time. The saved notice has **Show in Finder**. If the folder is missing or read-only, PaneLab says so and asks again.

## Settings

**Settings… (⌘,)** has three sections. **General** holds appearance, how Elements applies style edits, the screenshot folder, and updates. **Browser engines** and **Agents and MCP** are described in their own sections. Workspace options keeps only workspace-level actions: website languages, rename, reset sessions, and delete.

## Updates

PaneLab checks GitHub Releases once a day and when you choose **PaneLab → Check for Updates…**. Turn automatic checks off in **Settings → General**. A check is one anonymous request to `api.github.com`; it carries no identifiers.

When a newer version exists, the title bar shows **Update 0.x.y**. Open it (or **About PaneLab**) and select **Download update**. PaneLab downloads the release zip, then verifies it before staging anything:

1. The release's `SHA256SUMS.txt` must carry a valid Ed25519 signature from the PaneLab release key built into the app.
2. The zip must match its signed checksum.
3. The extracted bundle must be `dev.panelab.app` at the announced version, with an intact code signature.

**Restart to update** saves your sessions, quits, swaps the app bundle, and reopens PaneLab. If you quit instead, the update installs on the way out. A failed swap restores the previous app and tells you on the next launch.

PaneLab updates in place only when it can write to its own folder. If it runs from Downloads (macOS App Translocation), a read-only volume, or a folder you can't write to, About explains why and offers **Download manually**. Development builds never replace themselves.

## Keyboard shortcuts

**Help → Keyboard Shortcuts (⌘/)** lists every shortcut and filters as you type.

| Shortcut | Action |
| --- | --- |
| `⌘,` | Settings |
| `⌘/` | Keyboard shortcuts |
| `⌘L` | Focus the address bar |
| `⌘R` | Reload all previews |
| `⌘⇧S` | Screenshot the selected preview |
| `⌘⇧C` | Select an element in any preview |
| `⌘[` / `⌘]` | Back / forward |
| `⌘⇧]` | Select the next preview |
| `⌘1`–`⌘9` | Select a preview by position |
| `⌘=` / `⌘−` / `⌘0` | Zoom the canvas in / out / to 100% |
| `⌘⌥R` | Rotate phones and tablets |
| `Escape` | Cancel element picking, leave website input, or exit Zoom to preview |
| `Space` + drag | Pan the canvas |
| `⇧1` | Fit all previews |
| `⇧2` | Zoom to the selected preview |
| `⇧0` | Reset zoom to 100% |

Click a preview to send it keyboard input, and press Escape to give keys like Space back to the canvas. Copy, cut, and paste use the macOS clipboard.

## Emulation limits

- Emulation sets geometry and browser identity. It doesn't reproduce the operating system, so fonts, codecs, hardware features, browser chrome, and client hints can differ from a real device. Check on hardware when that matters.
- Previews are streamed screencast frames. Chromium runs at up to 60 fps, WebKit about 35 fps, and Firefox about 20 fps. When the canvas falls behind, older frames are dropped so a preview always shows its newest paint. Hidden and minimized previews pause capture while the page keeps running.
- Frames are CSS-pixel JPEGs. When a Chromium or WebKit preview is idle for about 250ms and shown above 1×, PaneLab swaps in a device-pixel PNG so text stays sharp. Firefox keeps CSS-pixel frames.
- Mouse, keyboard, touch taps, and scrolling are forwarded. Touch drags approximate scrolling. Over a desktop preview the pointer takes the website's cursor (hand, I-beam, resize, and so on); custom image cursors show their keyword fallback, and touch devices show a touch-point circle like Chrome's device mode. Text from non-US layouts is typed as text. Native pinch and swipe gestures and full IME composition aren't supported; committed text is.
- The canvas doesn't expose the page's accessibility tree, so PaneLab isn't a screen-reader testing tool.
- Inspection runs through page scripts, not engine debugging protocols. Pseudo-element rules, specificity ordering, breakpoints, and full DevTools are out of scope, and page scripts can change what the page reports.

## Data and privacy

PaneLab has no accounts, cloud service, or telemetry. Websites still make their own network requests, and update checks contact GitHub (see [Updates](#updates)).

Data lives in `~/Library/Application Support/PaneLab`. Settings are a versioned JSON file written atomically; if it can't be read, PaneLab keeps the original and starts fresh. Each workspace's session is a separate file encrypted with Electron `safeStorage` and the macOS Keychain. There's no plaintext fallback. A session file that can't be decrypted is renamed with `.unreadable-` and kept, so later saves don't overwrite it.

The renderer runs with context isolation, sandboxing, a strict CSP, and sender-checked IPC. Websites run in Playwright contexts inside a separate utility process, never in the app's own renderer.

To keep test data apart from your real data, point PaneLab at another folder:

```sh
PANELAB_DATA_DIR=/tmp/panelab-dev pnpm dev
```

## Troubleshooting

**macOS says PaneLab is damaged or can't be opened.** Release builds are unsigned. Run `xattr -dr com.apple.quarantine /Applications/PaneLab.app` once, then open it again.

**Updates say PaneLab can't replace itself.** Move `PaneLab.app` to `/Applications` and open it from there, or use **Download manually**.

**Engine unavailable.** Open **Browser engines**, enable the engine, and select **Download** or **Retry download**. Paused previews resume when it's ready.

**Connection refused.** Start your dev server and check the host and port. PaneLab opens HTTP, HTTPS, and local files.

**No file exists at this address.** Check the absolute path of the local file, then reload.

**HTTPS certificate error.** Trust your development certificate in macOS and reload. PaneLab doesn't bypass certificate checks.

**Session could not be decrypted.** Check that the Keychain is unlocked, then sign in again. The old file is kept beside the new one.

**Preview runtime stopped.** Reload a preview to restart the browser process. Errors stay visible in the affected panes.

**The site looks different on a real phone or in Safari.** Check **Display dimensions** and whether the pane is synthetic, then confirm on hardware.

**Electron is missing after `pnpm install`** (source builds). Run `pnpm exec install-electron`.
