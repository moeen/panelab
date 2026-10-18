<div align="center">

<img src="resources/panelab.png" alt="" width="112" height="112" />

# PaneLab

Your site in real Chromium, WebKit, and Firefox, on every device size, in one window.

[![CI](https://github.com/moeen/panelab/actions/workflows/ci.yml/badge.svg)](https://github.com/moeen/panelab/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/moeen/panelab?include_prereleases&sort=semver)](https://github.com/moeen/panelab/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS 15+ on Apple Silicon](https://img.shields.io/badge/macOS_15+-Apple_Silicon-black?logo=apple)

<img src="docs/assets/screenshot.png" alt="PaneLab showing one page on an iPhone in WebKit, a Pixel in Chromium, and a MacBook in Firefox, side by side on a canvas" width="900" />

</div>

PaneLab is a macOS app for responsive web work. Point it at `localhost:3000` and it opens the page on phones, tablets, and laptops at once, each running in a real browser engine. Scroll, click, and type in any of them. When something breaks on one device, the inspector shows you why.

## Features

- Every preview is a live Chromium, WebKit, or Firefox page with the device's viewport, pixel ratio, touch support, and user agent.
- Pick from 34 curated phones, tablets, and laptops, or define your own. Drag, resize, and arrange previews on a canvas, and zoom in on one.
- Mirror navigation, clicks, typing, and scrolling across previews when you want to, or keep each one independent.
- Sign in once. Previews in a workspace share cookies, localStorage, and IndexedDB across engines, saved encrypted with the macOS Keychain.
- Select an element once and compare its box and computed styles in every preview. Scan for overflow, engine differences, and mobile problems, then try CSS fixes live everywhere.
- Claude Code, Codex, Cursor, and other agents can open previews, take screenshots, scan, inspect, and diff through a CLI and an MCP server, with or without the app open.

## Install

### Download

1. Download `PaneLab-<version>-arm64.zip` from the [latest release](https://github.com/moeen/panelab/releases/latest) and unzip it.
2. Move `PaneLab.app` to `/Applications`.
3. The app isn't signed or notarized yet, so macOS blocks the first launch. Clear the quarantine flag once:

   ```sh
   xattr -dr com.apple.quarantine /Applications/PaneLab.app
   ```

### From source

You need Node.js 24 and pnpm 12.

```sh
git clone https://github.com/moeen/panelab.git
cd panelab
pnpm install --frozen-lockfile
pnpm dev
```

## Quick start

1. On first launch, choose the browser engines to download. Chromium and WebKit are preselected, and nothing downloads until you confirm.
2. Start your dev server and type its address, like `localhost:3000`, into the address bar.
3. Pick devices in the sidebar. Each one opens as a live preview.
4. Select a preview and open the inspector, or run **Findings → Scan previews** to look for layout problems.

The [usage guide](docs/usage.md) covers the canvas, sync, inspector, sessions, shortcuts, and troubleshooting.

## Use it from an agent

Open **Workspace options → Agents and MCP** to install the `panelab` command and add PaneLab to your MCP clients. Then:

```sh
panelab scan localhost:3000 -d iphone-16 -d macbook-air-13 -e webkit,chromium
panelab shot localhost:3000 -d iphone-16@webkit -d pixel-7 --out shots
panelab diff localhost:3000 -d macbook-air-13 --baseline .panelab/baseline
```

Without the app running, the CLI and MCP server run their own headless previews. With the app open and agent access on, agents work in a separate Agent workspace you can watch. See [agents, CLI, and MCP](docs/agents.md).

## Requirements

- macOS 15 or newer on Apple Silicon. Intel Macs and other systems aren't supported, and current WebKit builds no longer run on macOS 14.
- An internet connection for the first engine download. After that, PaneLab works offline with local sites and has no accounts or telemetry.

WebKit is the engine behind Safari, not the Safari app. Emulation covers geometry and browser identity, not the whole operating system, so confirm OS-specific behavior on real hardware.

## Documentation

- [Usage guide](docs/usage.md)
- [Agents, CLI, and MCP](docs/agents.md)
- [Development](docs/development.md) and [testing](tests/README.md)
- [Security policy](SECURITY.md)

## Contributing

Bug reports and pull requests are welcome. Read [AGENTS.md](AGENTS.md) for the codebase rules and [docs/development.md](docs/development.md) for setup. Run `pnpm check`, `pnpm typecheck`, and the tests for the area you changed before opening a pull request.

## License

[MIT](LICENSE)
