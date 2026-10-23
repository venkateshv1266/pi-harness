# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-23

First public release.

### Added

- Interactive, tiered installer: `core`, `subagents`, `jev`, `integrations`, and `local`.
- `update.sh` re-applies the recorded selection after a `git pull` and reports newly available
  components.
- `--uninstall` removes only what the installer recorded.
- `harness.json` component manifest, enforced by a drift test in CI.
- Governance files: MIT license, contributing guide, code of conduct, security policy, issue and
  pull-request templates, CI workflow.

### Changed

- `settings.json` is backed up before writing, and the installer aborts instead of overwriting a file
  it cannot parse.
- Model-role defaults are offered as a preset instead of being written blindly.
- `sync.sh` is now a maintainer-only local file, excluded from the repository.

- Corrected the documented Node floor to 22.19.0 and the pi install command; the installer now
  verifies the pi version before writing.

### Removed

- The local-only `stats` extension and vendored `utils/omp-stats` dashboard. Observatory remains the
  shared observability surface.
