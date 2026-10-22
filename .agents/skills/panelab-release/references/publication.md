# Publication and recovery

## Tag

- Tag only the reviewed, merged commit, after `node scripts/release.ts ci <sha>` passes and the commit is reachable from `origin/main`. Don't substitute another SHA or a PR check run.
- If a remote tag with that name exists, it must point at this commit; otherwise stop. Never delete, move, or force a tag.
- The tag starts `.github/workflows/release.yml`, which can use the signing secret. Follow that run for this exact tag.

## Draft

Before verifying, check the draft's metadata:
- It is on the exact tag and commit, titled `PaneLab vX.Y.Z`.
- `draft` is true and `prerelease` is false.
- The body matches `docs/releases/vX.Y.Z.md` byte for byte.
- It has exactly the three contract assets, none empty.

An existing release with that tag is state to inspect, not a reason to overwrite it.

Download the assets with `gh release download vX.Y.Z --repo moeen/panelab --dir <empty-temp-dir>`, then run step 5 of the procedure. Keep the smoke test's screenshots and report for the completion report. If full-suite or conditional native/download evidence is missing for the release tree, get it now or leave the draft.

## Publish

- Right before publishing, re-read the tag, body, and assets; stop if anything changed. Confirm no greater stable version is already published.
- Publish with step 6 of the procedure.
- Afterwards, independently re-read the release and `repos/moeen/panelab/releases/latest`: tag, title, body, `draft=false`, assets, latest selection, and `immutable=true` when immutability is on. Download the public ZIP and check it against the signed checksum.
- Close only issues the release actually fixes. Don't send announcements, and never publish security details before the coordinated advisory.

## Recovery

- Read state before acting. If the tag, workflow run, and a matching complete draft exist, resume at verification. If it's already published and matches, verify and report.
- For a partial upload, compare the existing assets' digests and upload only clearly missing files from the same build. Never `--clobber` or mix builds. If you can't establish where the bytes came from, stop and report.
- Never retry a write that timed out before reading state. Retry an infrastructure failure once, after confirming it was transient; code, test, or signature failures need a fix. Never loop reruns until green.
- Published tags and assets are permanent; ship a higher version to fix one.

## Repository settings

Change settings only when the task authorizes it, and read back each change. The approved baseline:
- Squash-only merges, title `PR_TITLE`, body `BLANK`.
- Completed branches deleted automatically.
- Immutable releases. Check that the returned `enabled` is true.
- A `v*` tag rule that allows creation and blocks updates and deletion.
- Required checks named after the current CI jobs.

Keep other settings, labels, Dependabot, secret scanning, and private advisories as they are.
