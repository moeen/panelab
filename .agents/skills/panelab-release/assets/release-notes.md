# PaneLab v{{version}}

## Highlights

{{One short paragraph about what this beta release changes for users.}}

## Changes

### Added

{{User-facing additions with PR/commit links, or None.}}

### Changed

{{Behavior changes with PR/commit links, or None.}}

### Fixed

{{Concrete fixes with PR/commit links, or None.}}

### Security

{{Coordinated public advisory/fix links, or None. Never expose embargoed details.}}

### Maintenance

{{Relevant dependencies, tooling, tests or repository maintenance, or None.}}

## Compatibility and migration

{{Breaking changes, affected saved data/CLI/MCP contracts and required actions, or None.}}

## Installation and updates

macOS 15+ on Apple Silicon. Download [PaneLab-{{version}}-arm64.zip](https://github.com/moeen/panelab/releases/download/v{{version}}/PaneLab-{{version}}-arm64.zip), unzip, and move PaneLab.app to /Applications.

The app is unsigned and unnotarized. For the first launch, clear quarantine with `xattr -dr com.apple.quarantine /Applications/PaneLab.app`. Existing installations on 0.3.0 or newer can update in the app; older versions need one manual update. Update downloads require PaneLab's Ed25519 signature and checksum verification.

## Known issues

{{Known release-specific issues and workarounds with links, or None reported.}}

## Verification

{{Actual pre-release checks, environment and dates/links. Record conditional native/download checks as passed, not run, or not applicable with a reason. Artifact verification is a later publication gate; link its evidence in the release completion report rather than claiming success in advance.}}

## Contributors

{{Actual contributors in the comparison range with relevant links; no invented credits.}}

## Full changelog

[{{previous-tag}}...v{{version}}](https://github.com/moeen/panelab/compare/{{previous-tag}}...v{{version}})
