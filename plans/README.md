# Implementation Plans

Prepared 2026-09-29 against commit `09e7f5c`. Plan 001 was executed in an isolated worktree, approved, and committed to `feature/MicroMetadata`.

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-password-gated-site-data.md) | Password-gated per-site SQLite Data API with view-only unlock links | P1 | L | — | DONE — committed to `feature/MicroMetadata` |

Status values: TODO, IN PROGRESS, DONE, BLOCKED (state the reason), REJECTED (state the reason). Executor updates the row when finished unless a reviewer owns the index.

The implementation was verified in `/tmp/jolt-host-site-data-kyqvbJ` before its feature-branch commit. Reviewer verified 195 server unit, 37 composable, and 45 integration tests; a production build with stale origins; and the exact documented to-do sample in Chromium against a distinct runtime origin, including SPA management links and read-only unlocks. See plan 001's approval notes and deployment prerequisites. No push or deployment was performed.

## Dependency notes

Plan 001 is a single coordinated release: isolate hosted HTML from Jolt's app origin **before** enabling password-authenticated data writes. Do not deploy its data endpoints against the existing shared `/view/<slug>` origin.

## Findings considered and rejected

- Executing uploaded backend code: much larger attack surface than a managed JSON-record API; not required for a shared to-do site.
- Exposing raw SQLite files or SQL queries to uploaded JavaScript: bypasses server-controlled authorization, quotas, and data boundaries.
- Treating an unlock-link view cookie as data-admin: a shareable view URL must not authorize writes.
