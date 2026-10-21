# Development

You need macOS 15 or newer on Apple Silicon, Node.js 24 (see `.node-version`), and pnpm 12.11.2 (see `packageManager` in `package.json`). [AGENTS.md](../AGENTS.md) has the contribution rules and module ownership, and [DESIGN.md](../DESIGN.md) describes the interface.

```sh
pnpm install --frozen-lockfile
pnpm dev                 # app with hot reload
pnpm check               # Biome lint and format check (pnpm format fixes)
pnpm typecheck           # strict TypeScript for Node, renderer, and tests
pnpm build               # typecheck, then build into out/
pnpm preview             # run the built app
pnpm dist                # unsigned PaneLab.app zip in dist/
```

`pnpm browsers:install` downloads Chromium, WebKit, and Firefox into Playwright's normal cache for tests and headless CLI runs. That cache is separate from the app's own downloads.

## Project layout

```text
src/
  cli/        panelab command (Node only; built to out/main/cli.js)
  core/       Lab API, headless backend, socket client, visual diff, client setup
  mcp/        MCP server over stdio
  main/       Electron lifecycle, native actions, persistence, agent socket
  preload/    Narrow, sandbox-compatible IPC bridge
  runtime/    Playwright engines, devices, frames, sync, diagnostics
  renderer/   React workspace, shadcn/Base UI controls, canvas, inspector
  shared/     Zod contracts, shared types, device-catalog.json
tests/        unit, renderer, integration, and Electron e2e suites
skills/       The agent skill installed by `panelab skill install`
resources/    App icon sources and exports
```

`electron-vite` builds the main process, the browser utility process, the CommonJS preload, and the Vite renderer. React renders the controls, while preview frames travel over a MessagePort straight to a canvas without touching React state. Each engine has one shared browser process, and each pane has its own context. The inspector and the custom-device editor load on demand.

Styling uses Tailwind CSS v4 with shadcn/ui components built on Base UI (`components.json`). Biome formats and lints. Vitest runs unit tests and real-browser React tests; Playwright Test runs the browser runtime in all three engines and drives the compiled Electron app.

## Tests

```sh
pnpm test                # everything routine: Vitest, build, runtime, and Electron suites
pnpm test:unit
pnpm test:renderer
pnpm test:integration    # BrowserRuntime in Chromium, WebKit, and Firefox
pnpm test:e2e            # build, then the Electron app
pnpm test:native         # opt-in, real macOS Keychain
```

The [testing guide](../tests/README.md) covers prerequisites, isolation rules, and what each tier proves.

CI runs Biome, the typecheck and build, Vitest, and the three-engine runtime suite on every push and pull request. The Electron and Keychain suites need a desktop session, so run them locally before a release.

## Releases

Bump `version` in `package.json`, commit, then push a matching tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The release workflow checks that the tag matches `package.json`, builds an unsigned arm64 `PaneLab-<version>-arm64.zip`, and publishes it with a `SHA256SUMS.txt` and its Ed25519 signature, `SHA256SUMS.txt.sig`, on GitHub Releases. Builds aren't signed or notarized, so users clear the quarantine flag once (see the README).

### Update signing key

The in-app updater (`src/main/updater.ts`) installs only releases whose checksums verify against the public key in `src/main/update-key.ts`. The release workflow signs with the `PANELAB_UPDATE_SIGNING_KEY` repository secret and fails without it.

To create or rotate the key:

```sh
node scripts/update-keys.ts ~/.panelab/update-signing.key   # writes the private key, rewrites update-key.ts
gh secret set PANELAB_UPDATE_SIGNING_KEY < ~/.panelab/update-signing.key
```

Commit the new `update-key.ts`. Copies built with an older key can't verify newer releases, so after a rotation those users update once by hand. Keep a backup of the private key outside the repository.

`pnpm dev` first runs `scripts/dev-bundle.ts`, which renames the local development Electron.app to PaneLab (and gives it the PaneLab icon), so the macOS menu bar shows the right name. Packaged builds already carry it.

## Icons

Vector sources, the 1024px PNG, and the ICNS file are in `resources/`. After editing `panelab-mark.svg`, run `pnpm icons:generate` with Playwright Chromium installed. Every export is recorded in `resources/provenance.json`.

## Device catalog

Built-in devices live in [`src/shared/device-catalog.json`](../src/shared/device-catalog.json) with source URLs and a research date. Portrait entries define the landscape variants, which are generated at runtime. When you remove a device, workspaces that still use it keep it as a custom profile.
