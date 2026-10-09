# Changelog

## 0.1.1 — 2026-10-09

### Fixed

- Save and clear the correct context-window field when editing models.
- Roll back configuration, credentials, and metadata when saving or reloading fails.
- Detect concurrent configuration changes and preserve newer edits during rollback.
- Keep credential writes private on POSIX and coordinate with Pi's directory-lock protocol.
- Prevent destructive synchronization when endpoint pagination is incomplete.
- Prefer exact model IDs, reject ambiguous catalog matches, accept zero pricing, and save sidecar-only metadata.

### Improved

- Replace decorative UI symbols with plain text labels and status descriptions.
- Preserve model-list filtering and selection, adapt to terminal height, and allow cancellation of network operations.
- Support cursor, page-number, and same-origin link pagination, with a preview before synchronization.
- Reuse the in-memory models.dev catalog index and build batch model changes before saving.
- Separate filesystem operations, model merging, and progress UI without new runtime dependencies.
- Add 43 regression tests and document storage, compatibility, and platform limitations.

## 0.1.0

- Initial Provider Manager extension for Pi Coding Agent.
