# Contributing to PaneLab

Bug reports and focused pull requests are welcome. Use the issue forms for bugs or feature
requests, search for an existing report first, and include the app version, macOS version,
engine/device, and a small reproduction. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), rather than in a public issue or PR.

Read [AGENTS.md](AGENTS.md), [PRODUCT.md](PRODUCT.md), and the
[development guide](docs/development.md) before changing code. Interface changes also follow
[DESIGN.md](DESIGN.md). Development requires macOS 15+ on Apple Silicon, Node.js 24, and
pnpm 12.11.2. Use the frozen lockfile and the existing test tools.

## Pull requests

Use a short-lived branch and fill in the PR template. Explain the problem and the resulting
behavior, link relevant issues, and report the checks you actually ran. Add focused behavioral
coverage and update documentation when behavior or limitations change. Test only with temporary
application data and local fixtures; never include authenticated sessions, credentials, signing
keys, or personal data.

Commit messages and squash commits are a single Conventional Commit title with no body, ideally
50 characters or fewer and never over 72, for example `fix(sync): preserve mirrored selection`.
Put migration, breaking-change, security, revert, and issue context in the PR instead; sensitive
security details belong in a private advisory.

Before merge, run `pnpm check`, `pnpm typecheck`, the relevant test tiers, and a production build;
changes crossing process or browser boundaries need the full routine suite (see
[tests/README.md](tests/README.md)). PRs are squash-merged into `main` once both required GitHub
checks pass for the reviewed head and review threads are resolved. Labels: `bug`, `enhancement`,
`documentation`, `performance`, `maintenance`, or `release`.

## Releases

Maintainers follow [the release procedure](docs/development.md#releases). Only the latest
release receives security fixes.
