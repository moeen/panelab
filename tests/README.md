# Testing PaneLab

Use Node.js 24 and pnpm 12.11.2. The full suite requires macOS 15+ on Apple Silicon, a desktop session, and the Chromium/WebKit/Firefox binaries installed by `pnpm browsers:install`. Test processes must be allowed to bind loopback sockets and launch browsers and Electron.

## Commands

| Command | Runs |
| --- | --- |
| `pnpm test` | Unit and React browser tests, a production build with strict typechecks, then three-engine integration and Electron tests |
| `pnpm test:unit` | Node unit tests, including real temporary filesystem operations |
| `pnpm test:renderer` | React, store, frame transport, and canvas tests in real Chromium |
| `pnpm test:integration` | BrowserRuntime and synchronization tests in Chromium, WebKit, and Firefox |
| `pnpm test:e2e` | Production build and Electron workflows/security tests |
| `pnpm test:native` | Production build and explicit real macOS Keychain verification |
| `pnpm test:watch` | Unit tests in watch mode |
| `pnpm test:coverage` | Vitest suites with V8 text, HTML, and JSON summary reports |

Run a focused Playwright case with `pnpm exec playwright test --project=runtime-chromium --grep 'case name'`. Use `--project=electron` for the already-built Electron suite. Normal `test:e2e` builds first to prevent testing stale output.

## Organization and behavior

- `unit/`: URL and command boundaries, schemas, catalog/identity resolution, error messages, preload channels, workspace/session persistence, protocol path resolution, and bounded diagnostics.
- `renderer/`: real React subscriptions and StrictMode lifecycle, diagnostics batching/limits, notice/dialog state, trusted frame transport, canvas scaling/input/composition, and frame updates without React commits.
- `integration/`: public BrowserRuntime commands, element selection/highlights/overrides/scans in every engine (`inspection.spec.ts`, using `fixtures/inspect.html`), real emulation, cross-engine shared storage, synchronization and skipped targets, frame acknowledgement/visibility, context and engine lifecycle, failures, and PNG capture. Synchronization helpers also exercise real forms, iframe matching, page bindings, and scrolling; `sync-input.spec.ts` (with `fixtures/sync.html`) covers mirrored keys, delayed navigation, drag and drop, mixed `<input>`/`<textarea>` fields, and the select picker.
- `e2e/`: the compiled Electron application, application controls, IPC/CSP/protocol security, file workflows, restart restoration, and owned utility-process recovery.
- Agent surfaces: `unit/` covers the Lab facade with a fake backend, CLI parsing and exit codes, client config merging in a temporary HOME, the socket service, visual diff, and Copy-for-agent briefs. `integration/agent.spec.ts` runs runtime `act`/`inspect.query`, a headless Lab, and the MCP server through an in-memory MCP client in every engine. `e2e/agents.spec.ts` covers the opt-in socket, the Agent workspace, and `--attach`.
- `fixtures/`: generated test data, a loopback website and validated observations, temporary resources, and the test-only Electron bootstrap.

Tests assert observable outcomes rather than broad snapshots or third-party component internals. Polling and locator assertions wait for bounded readiness; retries are disabled. Playwright runs one worker to limit resource use and avoid overlapping desktop windows.

Vitest does not typecheck TypeScript during execution. `pnpm typecheck` checks application code, test code, configurations, and CommonJS fixtures separately. Biome checks the same sources. Its empty-pattern exception is limited to Playwright callbacks, whose dependency injection requires destructured parameters.

## Data and native boundaries

Every filesystem/application test owns a fresh directory under the OS temporary directory. Routine Electron tests copy installed browser bundles into their own cache with APFS copy-on-write clones where available, preserving relative symlinks. Setup/download tests replace only the installer entrypoint with a test-only bundle-copy fixture; no routine test performs network downloads. The browser runtime still launches real engines, and cleanup never touches the source cache. Configured fixtures seed settings explicitly; onboarding fixtures start with no settings or downloads. The Electron bootstrap sets both `userData` and `sessionData` before importing the compiled application. It also replaces native clipboard and file-dialog methods; generated files stay in the fixture directory. Tests never load the user's application data or authenticated browser profiles.

Routine Electron tests replace only the `safeStorage` boundary with Node AES-GCM using a generated key retained in the fixture process across restarts. The key is not written to disk. These tests prove application persistence and failure handling, not Keychain integration. This substitute is loaded only by the test bootstrap, not by production entrypoints.

`pnpm test:native` uses real `safeStorage` and macOS Keychain. Run it explicitly when native encryption needs verification. The native project is registered only when this command enables `PANELAB_NATIVE_TESTS=1`, so an unfiltered Playwright run also excludes it by default. An unavailable Keychain fails the suite; it does not silently skip verification or enable plaintext storage. Native file dialogs and clipboard remain stubbed.

Playwright's Electron automation is experimental. The application keeps context isolation, renderer sandboxing, CSP, and its narrow bridge. Browser/Electron fixtures close their owned resources and remove temporary data. Failure traces and screenshots remain under `test-results/`; the local HTML report is `playwright-report/`.

For a real in-application download smoke check, run `PANELAB_TEST_REAL_DOWNLOAD=1 pnpm exec playwright test --project=electron tests/e2e/engines.spec.ts --grep 'first launch requires explicit'` after building. This test explicitly selects Firefox, downloads into a temporary application-owned cache through the real app-owned Node installer process, verifies rendering and restart, and removes its test data. It requires network access and stays outside the routine suite.

## Coverage and limits

V8 reports are under `coverage/`. They cover execution in Vitest's Node/browser projects. Playwright runs, the browser utility process, and native Electron execution do not contribute to that report, so a zero there can coexist with integration/Electron coverage. No blanket coverage percentage is used as a release gate.

Native OS file-dialog presentation, full IME behavior, physical-device fidelity, long-duration performance, and the packaged `.app` remain outside automated coverage. Temporary website observations provide evidence for canvas input because previews do not expose their remote accessibility trees.

For a change, run the affected tier first, then `pnpm check`, `pnpm typecheck`, and the production build. Run the full suite when a change crosses process or browser boundaries. Report actual results and unresolved failures; a build alone does not establish live behavior.
