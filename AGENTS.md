# Working on PaneLab

PaneLab is a local macOS application for Apple Silicon. Read [README.md](README.md) for setup and [PRODUCT.md](PRODUCT.md) for product constraints. Read [DESIGN.md](DESIGN.md) before changing the interface.

## Stack and commands

Use Node.js 24 and pnpm 12.11.2. Keep `pnpm-lock.yaml` authoritative. UI primitives are shadcn/ui using **Base UI**, styled with **Tailwind CSS v4**. Use Biome for formatting and linting.

```sh
pnpm install --frozen-lockfile
pnpm browsers:install # Optional developer/test binaries; app downloads are selected in its UI.
pnpm dev
pnpm check
pnpm typecheck
pnpm build
node out/main/cli.js --help   # headless CLI; `node out/main/cli.js mcp` serves MCP
pnpm dist                     # unsigned PaneLab.app zip in dist/
```

Maintain focused unit, renderer, integration, and end-to-end coverage for behavior changes. Do not add test frameworks, code signing or notarization, cloud services, or telemetry unless requested. Releases are unsigned zips built by `.github/workflows/release.yml`. Verify behavior in the development application or the compiled Electron suite. Use temporary data and a local fixture for browser verification; never reuse the user's authenticated sessions. See [tests/README.md](tests/README.md) for commands and isolation rules. Real Keychain verification is opt-in via `pnpm test:native`.

## Module ownership

- `src/shared/contracts.ts`: validated commands, persistence schemas, and shared types. Keep all external inputs validated and all renderer commands narrow.
- `src/shared/device-catalog.json`: curated, sourced built-in profiles. Maintain research dates, source URLs, CSS geometry, native panel metadata, and aliases. Never invent a usage-coverage percentage. Runtime derives landscape variants; do not restore the entire Playwright library to the sidebar.
- `src/main`: application lifecycle, native dialogs, clipboard, settings, encrypted session snapshots, explicit engine downloads/cache cleanup, and runtime coordination.
- `src/main/updater.ts`: `update.*` commands, the daily check schedule, GitHub release checks, verified downloads (Ed25519 over `SHA256SUMS.txt`, checksum, bundle id/version, `codesign`), and the bundle-swap helper. Never trust URLs from the GitHub API; rebuild them from the validated version. `update-key.ts` holds the public key; `scripts/sign-update.ts` signs in CI.
- `src/shared/shortcuts.ts`: the single list behind menu accelerators, window-level renderer keys (`matchShortcut`), and the Keyboard Shortcuts sheet. Add shortcuts here, not in `createMenu` or ad hoc `keydown` checks; `hint` entries only document keys a component owns.
- `src/preload`: sandbox-compatible CommonJS bridge. Expose only `bootstrap`, `send`, and `subscribe`; never expose raw IPC or filesystem access.
- `src/runtime`: Playwright process ownership, device resolution, streamed frames, input/synchronization, and diagnostics. Browser complexity belongs behind `BrowserRuntime.execute`.
  - `page-agent.ts` is the only code that runs inside website documents (sync capture, page reading, and the inspection API). It is serialized as an init script, so it must stay self-contained; `agent.ts` validates everything it returns.
  - `inspection.ts` owns selection, highlights, Live CSS/inline overrides, and scans; `findings.ts` is the pure ranking logic. Element matching across panes uses `resolveTarget` in `sync.ts`, shared with synchronization.
- `src/shared/inspection.ts`: inspection commands, events, and bounded schemas for website-reported data.
- `src/shared/emulation.ts`: per-preview media features and per-workspace website languages. Media changes apply live with `emulateMedia`; a language change recreates contexts because locale is fixed per context.
- `src/shared/agent.ts`: the Lab API contract (bounded request schemas, result types, socket framing) shared by the CLI, MCP server, and app socket.
- `src/core`: Node-only and never imports Electron. `lab.ts` is the agent-facing facade over a `LabBackend` (workspace + runtime commands + events). `headless.ts` hosts `BrowserRuntime` in-process. `remote.ts`/`connect.ts` attach to the app socket. `clients.ts`/`install.ts` write MCP client configs, the CLI shim, and skills. `diff.ts` compares PNGs.
- `src/cli` and `src/mcp`: thin adapters over `LabApi`. Keep logic in `core`; the MCP server writes only protocol frames to stdout.
- `src/main/agent.ts`: the opt-in agent socket (0600, off by default) and the app `LabBackend`. Agents act only in the workspace flagged `agent`. Never add arbitrary evaluation, TCP listeners, or writes outside the client config files the user asked for.
- `src/renderer`: application controls, layouts, inspector, and canvas presentation. Keep browser-frame bytes and transient input outside React state.

Prefer existing modules and native APIs. Add dependencies only when an installed library or a small direct implementation cannot solve the concrete requirement. Use strict TypeScript; avoid `any`, unchecked casts, and non-null assertions.

## Invariants

- Real Chromium/WebKit/Firefox contexts render every preview. Panes in a workspace share one website session across engines: `src/runtime/session.ts` synchronizes cookies and localStorage live and seeds IndexedDB when a context is created. Pure snapshot merge/diff rules live in `src/shared/session.ts`.
- Use engine-compatible identities and Playwright descriptors, including viewport, screen, DPR, mobile, and touch settings. Unsupported device/engine pairs require explicit synthetic opt-in and visible labeling.
- Canvas zoom and preview width change display scale. Changing a device changes emulation and recreates its context while preserving supported storage and capture visibility.
- Keep the visible preview frame at the CSS viewport ratio, with header and footer outside the website stage. Built-in viewports use full logical screens; native panel pixels are metadata. MacBook Retina 2× presets do not claim macOS default scaled resolution. Preserve referenced removed descriptors as custom profiles during catalog updates.
- Shared navigation/reload always affects all panes. Semantic synchronization starts disabled, honors category toggles and pane exclusion, and visibly skips missing or ambiguous targets.
- Keep one shared browser per engine, serialize operations per pane, coalesce transient input, bound frame delivery and diagnostics, pause hidden capture, and clean up contexts/processes.
- Preserve context isolation, renderer sandboxing, CSP, sender validation, and the secure local application protocol. Website content runs only in the Playwright process.
- Store sessions encrypted using macOS `safeStorage`. Never fall back to plaintext. Snapshot cookies, localStorage, and IndexedDB only, one encrypted file per workspace; sessionStorage, cache, and full profiles are outside scope.
- Preserve unknown/corrupt workspace files before recovery. Keep persistence versioned and writes atomic.
- Inspection evaluates in each page's main world and treats results as untrusted. Highlights render in the renderer overlay, never inside the website. Live CSS uses an adopted stylesheet, stays in runtime memory for the active workspace, and is not persisted.
- Provide keyboard alternatives to app controls, visible focus, readable contrast, and reduced-motion behavior. Canvas previews do not expose remote accessibility trees.

## Documentation and checks

Update documentation when behavior, limitations, or commands change. Report actual verification and remaining gaps; a successful build does not prove live browser behavior. Run the relevant typecheck and Biome checks, then the production build after implementation changes. Do not repeat successful checks without a new change or unresolved failure.

`pnpm test` runs all routine tiers and builds once. Use focused `test:unit`, `test:renderer`, `test:integration`, or `test:e2e` commands while iterating. `pnpm test:coverage` measures Vitest execution only; Playwright and native processes are outside that report. Keep fixtures and test-only native substitutions under `tests/`; do not add production test commands or weaken sandboxing, CSP, or sender validation.

## Current library documentation

Use Context7 MCP for library/framework/SDK/API/CLI/cloud setup, syntax, migration, and library-specific debugging, even for familiar tools. Start with `resolve-library-id` using the library and concrete question, choose the best reputable match (version-specific when available), then call `query-docs` with the full question. Prefer these docs to web searches. General programming, business-logic debugging, refactoring, scripts, and code review do not require Context7.
