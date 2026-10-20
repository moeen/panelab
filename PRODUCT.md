# PaneLab

## Platform

web

Electron desktop application for macOS 15+ on Apple Silicon. The web value describes the renderer; this is not a hosted web product.

## Stack

Electron, Playwright, TypeScript, React, Tailwind CSS, and shadcn/ui. One pnpm package. Unsigned Apple Silicon builds are published as zip files on GitHub Releases; signing and notarization are out of scope.

## Users

Developers comparing responsive websites and debugging differences across browser engines and device dimensions during daily macOS work.

## Product Purpose

Keep multiple real Chromium, WebKit, and Firefox pages visible and interactive in one window. Combine device emulation, optional semantic interaction synchronization, and per-pane diagnostics.

## Operating Context

Localhost and remote HTTP/HTTPS websites, and local HTML files. Usually four to eight active previews. No hard pane-count limit, accounts, cloud infrastructure, or telemetry. Used directly or through coding agents (Claude Code, Codex, Cursor, VS Code, Gemini CLI, Zed) via a headless CLI and MCP server. Agents can also drive the open app through an opt-in, owner-only local socket.

## Capabilities and Constraints

A pan-and-zoom preview canvas with free placement and arrange modes, custom device profiles, presets, screenshots, console/errors/network inspection, cross-preview element inspection with side-by-side style comparison, ranked overflow/engine-difference findings, session-only Live CSS applied to every preview, autosaved workspaces, and one remembered website session per workspace, shared by every preview and engine. Shared address and reload commands affect all panes; the address bar shows the selected pane's location, and back/forward follow the selected pane or, with navigation synchronized, every participating pane. Synchronization starts disabled. Sessions restore cookies, local storage, and IndexedDB, not complete browser profiles. WebKit is Safari-compatible, not branded Safari. Streamed input does not reproduce native gestures or the full IME composition lifecycle; native dropdowns open a PaneLab-drawn option list, while date, color, and datalist popups are unsupported. Synthetic device/engine pairs require opt-in and show their effective emulated identity, including Firefox phone/tablet profiles. Browser engines are selected and downloaded explicitly during first setup, then managed in settings. Disabling retains downloads and sessions; settings report occupied disk space and can remove disabled-engine downloads from an app-owned cache. New workspaces start empty or use a saved preset.

The device library is a curated local JSON catalog with source references and searchable equivalent-model aliases. It targets common screen-size families rather than claiming measured 90% device usage coverage. CSS screen/viewport geometry and native panel pixels are distinct. Built-in previews render full logical screens without browser chrome; MacBook profiles use explicit Retina 2× presets. Preview frames preserve website proportions; width is free and height follows the CSS viewport ratio.

## Brand Commitments

PaneLab. Modern, minimal macOS application. System appearance with manual overrides, system typography, compact familiar controls, a dominant comparison canvas, and a bottom inspector.

## Product Principles

- Real engine rendering and honest emulation descriptions.
- Independent panes remain useful without synchronization.
- Keep high-frequency rendering outside React state.
- Local persistence, bounded diagnostics, and deterministic cleanup.
- Validate external inputs; keep the architecture small and typed.

## Accessibility & Inclusion

Keyboard-operable application controls, visible focus, accessible labels, readable contrast, and reduced-motion support. Canvas previews do not expose the remote page's accessibility tree.
