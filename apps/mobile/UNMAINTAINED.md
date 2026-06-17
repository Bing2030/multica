# ⚠️ Archived / Frozen — Mobile App (`apps/mobile/`)

**Status:** archived / frozen as of 2026-06-17. The mobile app is no longer
built, tested, or shipped. Source is kept in place for reference and the
archive is fully reversible.

This was done as part of the repo-simplification pass (branch
`chore/repo-simplify-moderate`) to de-prioritize mobile and shrink the
maintenance surface. **Web and desktop remain the active clients.**

## What "frozen" means

- **Not built or CI'd.** The dedicated mobile workflow
  (`.github/workflows/mobile-verify.yml`) has its auto-triggers removed
  (manual `workflow_dispatch` only). The main CI workflow
  (`.github/workflows/ci.yml`) already excluded mobile via
  `--filter='!@multica/mobile'`.
- **No dev scripts.** The `dev:mobile*` and `ios:mobile*` scripts were
  removed from the root `package.json`.
- **Still in the workspace graph.** `apps/*` stays in
  `pnpm-workspace.yaml` so `pnpm install` still resolves cleanly; no
  source under `apps/mobile/` is deleted.
- **Source untouched.** All code under `apps/mobile/` (including
  `apps/mobile/CLAUDE.md`) is preserved as-is as a historical reference.

## To un-archive (re-enable)

1. Restore the `dev:mobile*` and `ios:mobile*` scripts in the root
   `package.json` (recover them from git history).
2. Restore the `on:` push/pull_request trigger block in
   `.github/workflows/mobile-verify.yml` (recover from git history; the file
   is kept, only its triggers were replaced with `workflow_dispatch`).
3. Re-read `apps/mobile/CLAUDE.md` — it documents the locked tech-stack
   baseline (Expo SDK 55 / React Native 0.82 / React 19.1), the import
   whitelist (`import type` from `@multica/core/types/*` + pure functions
   only), and the mobile-specific rules. Verify the pinned versions still
   install cleanly before resuming active development.

## Removed as stale during archival

Two transient planning docs were deleted because they no longer matched
the code state:

- `apps/mobile/docs/rnr-migration.md` — referenced `sheet-shell.tsx`
  ("imported by 18 files"), which had already been deleted; the migration
  it tracked is complete.
- `apps/mobile/docs/project-v1-gap-audit.md` — its headline gap ("Tier B
  picker migration not finished") had landed; the project pickers are now
  `*-body.tsx` route modals.

The durable decision records (`markdown-rendering-adr.md`,
`markdown-rendering-research.md`) and `apps/mobile/CLAUDE.md` are retained.