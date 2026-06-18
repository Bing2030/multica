# Review: chore/repo-simplify-moderate vs origin/main

Date: 2026-06-18
Branch: chore/repo-simplify-moderate
Baseline: origin/main at 8e05d689
Head: 686fad3f Fix dev CLI version fallback

## Scope

Compared `HEAD` against `origin/main` after fetching the latest remote main.

Branch commits:

- 686fad3f Fix dev CLI version fallback
- 7e47db7d refactor(server): drop PostHog analytics transport, keep event model for Prometheus
- e3d2c2aa refactor(server): make file storage local-only, drop S3/CloudFront/SecretsManager

Diff size:

- 46 files changed
- 176 insertions
- 1971 deletions

## Summary

The branch removes server-side PostHog transport code and removes S3, CloudFront, and SecretsManager storage paths. Server analytics events are now retained as the event model for Prometheus counters. Attachment storage now initializes local filesystem storage only. The final commit updates source-built CLI version derivation so repositories without tags synthesize a `v0.0.0-0-g<hash>` git-describe shape instead of reporting a bare SHA that the quick-create CLI gate treats as missing.

## Findings

### 1. Presign download mode still returns 500 with the only remaining storage backend

Severity: High

`server/cmd/server/router.go:130` to `server/cmd/server/router.go:132` now always wires `storage.NewLocalStorageFromEnv()`. `server/internal/storage/local.go:16` to `server/internal/storage/local.go:19` defines `LocalStorage`, and it does not implement `storage.DownloadPresigner`.

However, `server/internal/handler/file.go:226` to `server/internal/handler/file.go:233` still accepts `ATTACHMENT_DOWNLOAD_MODE=presign`. If that setting is present, `DownloadAttachment` enters the presign branch and returns 500 when the storage backend does not implement `DownloadPresigner` (`server/internal/handler/file.go:617` to `server/internal/handler/file.go:621`).

Existing deployments that previously used S3 presigned downloads can carry `ATTACHMENT_DOWNLOAD_MODE=presign` into this branch and break every attachment download after startup. Since local storage is now the only backend, presign should either be removed from the accepted modes or normalized to proxy with a warning.

### 2. Operator-facing env/docs still advertise removed S3/CloudFront and server PostHog behavior

Severity: Medium

The runtime now ignores S3/CloudFront entirely: `server/cmd/server/router.go:130` to `server/cmd/server/router.go:132` creates only local storage, and the AWS/CloudFront implementations were deleted.

But `.env.example:124` to `.env.example:150` still documents and exposes `S3_BUCKET`, AWS credentials, `CLOUDFRONT_*`, and CloudFront cookie behavior. `.env.example:159` also says local storage is a fallback when `S3_BUCKET` is not set, which is no longer true.

Similarly, `server/internal/analytics/client.go:1` to `server/internal/analytics/client.go:7` says the PostHog transport has been removed, but `.env.example:268` to `.env.example:278` and `docs/analytics.md:1` to `docs/analytics.md:78` still describe server-side PostHog shipping, `NewFromEnv`, queueing, batching, and no-op clients.

This will mislead self-host operators: S3/CloudFront settings are silently inert, and server PostHog settings no longer do what the docs say.

## Notes

- The final CLI version fallback is consistent with the frontend and backend quick-create version regexes: both accept the synthesized `v0.0.0-0-g<hash>` shape.
- Some internal comments still refer to S3/CloudFront in `server/internal/handler/file.go`, `server/internal/storage/local.go`, and related tests. These are lower risk than the env/docs issue above, but they are worth cleaning up with the same documentation pass.

## Verification

Passed:

- `git diff --check origin/main...HEAD`
- `go test ./cmd/server ./internal/analytics ./internal/handler ./internal/metrics ./internal/service ./internal/storage`
- `go test ./pkg/agent -run TestCheckMinCLIVersion`
- `pnpm --filter @multica/core exec vitest run runtimes/cli-version.test.ts`

Full-suite caveat:

- `go test ./...` failed in `server/pkg/agent` on provider fixture timeout/initialization tests after the localhost-binding sandbox issue was removed by an elevated rerun. The changed server packages passed in the focused run above, and the focused CLI version test passed.

## Git Actions

Committed and pushed:

- Commit: 686fad3f Fix dev CLI version fallback
- Remote update: origin/chore/repo-simplify-moderate

Left local:

- `.codegraph/` remains untracked.
- This review file is local and was not included in the pushed code commit.
