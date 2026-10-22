---
name: panelab-release
description: Prepare, run, check, or recover a PaneLab release of moeen/panelab, covering version bump, release notes, release PR, tag, draft verification, and publication. Use when asked to prepare, ship, publish, check the status of, or recover a PaneLab release; not for ordinary feature work.
---

# PaneLab release

The human procedure is [docs/development.md#releases](../../../docs/development.md#releases). Follow it step by step; this skill adds what an agent must decide or must not do. Paths are relative to the repository root.

## Scope

- **Prepare**: version, notes, and an open `release/vX.Y.Z` PR. Stop before merging or tagging.
- **Release / ship / publish**: the full cycle through publication and post-release checks. Don't re-ask for steps the request already authorized; a narrower request limits scope.
- **Status**: read-only report of evidence and remaining gates.
- **Recover**: inspect the existing tag, workflow run, draft, and assets before choosing the next step. See [publication and recovery](references/publication.md).

Invoking the skill does not authorize publication. Don't change repository settings or do unrelated product work unless the task asks for it.

## Version and range

- Compare against the latest **published** stable release reachable from the candidate, never an unpublished tag or draft. Read both commits and merged PRs, so direct commits are included.
- Pick the highest bump any change requires (see the docs). An explicit valid version from the user wins; flag downgrades or mismatched classifications. Ask before 1.0 or a prerelease.
- No payload change since the last release means no release, unless the user asks for a rebuild.
- Bump only `version` in `package.json`; leave the lockfile alone unless dependencies changed.

## Commits and PRs

- Every commit and squash subject is a single Conventional Commit title with no body or trailers, as `CONTRIBUTING.md` describes. Use the `caveman-commit` skill to write it if available, but ignore its body guidance. The release PR is titled `chore: release X.Y.Z`.
- Stage only task files. Never amend, force-push, rebase published history, skip hooks, or merge with `--admin`.
- Fill in the PR template from the final diff and real check results.
- Merge only when both required checks (`Lint, types, build`, `Tests`) succeeded on the current head and threads are resolved. Missing or skipped checks are failures. Merge with `gh pr merge --squash --match-head-commit <reviewed-sha> --subject <title> --body ''`.

## Release notes

Copy [the template](assets/release-notes.md) to `docs/releases/vX.Y.Z.md` and keep all sections and Changes categories in order, writing `None.` where empty. `node scripts/release.ts check vX.Y.Z` checks structure only; review that every claim is true and every relevant commit is covered. **Verification** lists checks already run; artifact verification comes later and goes in the completion report. Correct notes after tagging through a PR, then mirror the change to GitHub.

## Gates and publication

Required checks that are missing or failed block publication; report the gap rather than weakening the gate. Read [publication and recovery](references/publication.md) before pushing a tag or changing a release.

The release contract the in-app updater depends on:
- Assets are exactly `PaneLab-X.Y.Z-arm64.zip`, `SHA256SUMS.txt`, and `SHA256SUMS.txt.sig`.
- The ZIP holds only `PaneLab.app`, with bundle id `dev.panelab.app` and the release version.
- Clients read `/releases/latest`, ignore drafts and prereleases, and verify with `src/main/update-verify.ts`.
- Never rotate the update key, add Apple signing, or introduce channels as part of a release.
- Follow `SECURITY.md` for anything security related.

## Completion report

Always report these fields:
- **Outcome**: prepared, draft, published, or blocked.
- **Version and comparison range.**
- **PRs and commit.**
- **Verification**: checks, workflow run, packaged smoke, and any native or download checks.
- **Assets and release URL.**
- **Remaining gaps / next action**: write `None.` if there are none.

A blocked run reports the current state and the concrete next step.
