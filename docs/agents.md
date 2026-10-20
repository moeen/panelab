# Agents, CLI, and MCP

PaneLab works with coding agents such as Claude Code, Codex, Cursor, VS Code, Gemini CLI, and Zed. Agents get the same operations you have in the app: open previews, click and type, take screenshots, scan for findings, inspect elements, apply Live CSS, and diff screenshots across engines or against a baseline.

## Two modes

**Headless** is the default when the app is closed or agent access is off. The CLI or MCP server starts its own Playwright previews in-process and closes them when done. It uses PaneLab's downloaded engines if they exist, otherwise Playwright's normal cache (`pnpm browsers:install`). Headless runs start signed out and never read the app's encrypted sessions; pass `--storage-state auth.json` (a Playwright storage-state file) to sign in.

**Attached** applies when the app is open with agent access on. Agents work in a dedicated **Agent** workspace, which becomes active so you can watch. Your other workspaces aren't touched, and an agent command that arrives after you switch away fails instead of running in your workspace. The title bar shows **Agents on**, or **Agent connected** while a client is connected.

`--headless` and `--attach` force a mode. Every result says which mode it used.

## Setup

In the app, open **Workspace options → Agents and MCP**:

1. Turn on **Let agents use this window** if you want agents to drive the open app. It's off by default.
2. Under **Command-line tool**, select **Install**. This writes `~/.local/bin/panelab`, a small shell script that runs the CLI with PaneLab's bundled Electron, so you don't need Node.js. Add `~/.local/bin` to your `PATH`.
3. Select **Add** next to each MCP client you use.

PaneLab edits only that client's user config and only its own `panelab` entry. The first time it changes a file it keeps the original as `<file>.bak`. Symlinked configs are written through, so a dotfiles setup keeps working. Claude Code is configured with `claude mcp add --scope user` when the `claude` command exists, falling back to editing `~/.claude.json` if that fails. Zed settings with comments are never rewritten; use **Copy configuration** and paste the entry yourself. PaneLab won't replace a `~/.local/bin/panelab` it didn't write.

From a source checkout, after `pnpm build`:

```sh
pnpm link --global                        # puts `panelab` on PATH (or use the shim from the app)
panelab mcp install --client claude-code  # also codex, cursor, vscode, gemini, zed
panelab mcp config --client codex         # print the entry without writing it
panelab skill install                     # Claude Code skill; --client codex for ~/.agents/skills
```

To set up a client by hand, run `panelab mcp` over stdio:

```json
{ "mcpServers": { "panelab": { "command": "/Users/you/.local/bin/panelab", "args": ["mcp"] } } }
```

Codex reads TOML from `~/.codex/config.toml`:

```toml
[mcp_servers.panelab]
command = "/Users/you/.local/bin/panelab"
args = ["mcp"]
```

## MCP tools

| Tool | What it does |
| --- | --- |
| `list_devices`, `list_previews` | The device library, and open previews with viewport, status, and errors |
| `open_preview` | Open a URL on devices × engines and wait for it to load |
| `navigate`, `reload`, `go_history`, `close_previews` | Navigation and cleanup |
| `act` | click, fill, press, hover, scroll, or waitFor by CSS selector or text, in every preview |
| `screenshot` | Device-pixel PNG files, plus small inline JPEG previews |
| `scan_findings` | Ranked overflow, engine-difference, unsupported-CSS, engine-only error, and mobile findings |
| `inspect_element` | One element matched across previews, with the computed values that differ |
| `read_preview` | Title, headings, landmarks, visible text paged by `offset`, and operable elements with role, accessible name, state, and a selector verified unique for `act`; `missingIn` names previews without that element |
| `get_console`, `get_network` | Recent diagnostics per preview |
| `set_live_css` | Try CSS in every preview without touching project files |
| `visual_diff` | Diff engines per device, or compare against a baseline folder |

Every tool declares input and output schemas and read-only or destructive hints. Errors come back as tool errors with a suggested next step. The server also exposes `panelab://devices` and `panelab://previews` resources and a `responsive_audit` prompt.

Agents can't run arbitrary JavaScript. An action whose target is missing or matches more than one element reports `missing` or `ambiguous` instead of guessing. `read_preview` never returns password, one-time-code, or payment field values; those elements carry the `redacted` state. It reads the main frame's light DOM: content inside iframes and shadow roots isn't listed, though `act` selectors can still reach open shadow roots. `open_preview` accepts `media` (for example `{ "colorScheme": "dark" }`) and `languages` (for example `["de-DE", "en"]`), and URLs may be local files.

## CLI

```sh
panelab devices --search pixel
panelab shot localhost:3000 -d iphone-16 -d pixel-7 --out shots
panelab scan localhost:3000 -d iphone-16 -d macbook-air-13 -e webkit,chromium
panelab inspect localhost:3000 '.hero h1' -d iphone-16 -e webkit,chromium --synthetic
panelab read localhost:3000 -d iphone-16 --within main --limit 50
panelab act localhost:3000 click 'button[aria-label="Menu"]' -d iphone-16
panelab open ./dist/index.html -d pixel-7 --dark --lang de-DE,en
panelab diff localhost:3000 -d macbook-air-13 --baseline .panelab/baseline   # first run saves, later runs compare
panelab watch localhost:3000 -d iphone-16 --paths src --run scan
```

`-d iphone-16@webkit` pins one device to one engine, and `-e` applies to the rest. Without `-d`, commands use iPhone 16, Pixel 7, iPad Air 11″ (M3), and MacBook Air 13.6″. In attached mode with previews already open, commands reuse them.

Paths resolve against your current directory. Without `--out`, `shot` and `diff` create a new `panelab-shots-*` or `panelab-diff-*` folder there, so add `panelab-*/` to your project's `.gitignore` or pass `--out`.

Output is compact text in a terminal and JSON when piped or with `--json`. Exit codes: `0` success, `1` a failed action or a changed diff, `2` usage error, `3` engine or app unavailable.

## Copy for agent

The **Findings** toolbar and the **Elements** header each have a copy button. It copies a Markdown brief with each issue's selector, the affected devices and engines with their CSS viewports, the likely cause or differing values, and the `panelab` command that reproduces it.

The [PaneLab skill](../skills/panelab/SKILL.md) teaches agents the fix-and-verify loop.

## How the socket is secured

The only way to control the running app is the agent socket, `agent.sock` in the data folder. It exists only while agent access is on, and it's created with mode 0600 inside a private folder, so only your macOS account can connect. It accepts validated Lab requests and nothing else: no code evaluation, no TCP. A request larger than the frame limit closes the connection, and nothing sent after it runs.

The app writes screenshots and diffs only to its own temporary folder. The CLI or MCP server copies them to the paths you ask for.
