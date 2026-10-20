# Security policy

## Reporting a vulnerability

Please don't open a public issue for security problems. Report them privately through [GitHub Security Advisories](https://github.com/moeen/panelab/security/advisories/new). Include the PaneLab version or commit, your macOS version, and steps to reproduce.

You should get a reply within a week. Fixes ship in the next release, and the advisory is published once a fix is out.

## What counts

PaneLab runs websites in local browser processes and can be driven by coding agents, so these areas matter most:

- The agent socket (`agent.sock`, owner-only, off by default) and the requests it accepts
- The MCP server and the `panelab` CLI, including the paths they write to
- Renderer isolation: context isolation, sandboxing, CSP, IPC sender checks, and the `panelab://` protocol
- Encrypted website sessions stored with macOS `safeStorage`
- MCP client config files PaneLab edits when you ask it to
- Local files: the address bar, CLI, MCP server, and agent socket can open `file://` URLs, so an agent can render and read (`read_preview`) any file your account can read. Turn agent access off if that's not acceptable.
- Page reading: `read_preview` validates everything the page returns and never returns password, one-time-code, or payment field values
- The screenshot folder is chosen only through a native dialog in the main process; renderer commands never carry a path

Bugs in the websites you preview, or in Chromium, WebKit, or Firefox themselves, belong with those projects.

## Supported versions

Only the latest release gets security fixes.
