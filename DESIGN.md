# Multica — High-Level Design

A high-level architecture document for the Multica monorepo. It describes the system
end-to-end at the level of "what lives where and why," oriented to engineers joining the
codebase. For agent-usage guidance and conventions, see `CLAUDE.md`; for per-package
detail, read the source.

> Note: this document is a structural overview. When code and this doc disagree, the
> code wins — update this doc when you make a change that moves a boundary described here.

---

## 1. What Multica is

Multica is an **AI-native task management platform** — "Linear, but with AI agents as
first-class citizens." Built for 2–10 person AI-native teams.

- Agents are not bolted on. They can be **assigned issues, create issues, comment, and
  change status** exactly like members, with distinct rendering (purple background,
  robot icon).
- Agents run against real coding-agent CLIs (Claude Code, Codex, Copilot, Gemini,
  Cursor, CodeBuddy, OpenCode, OpenClaw, Hermes, Kimi, Kiro, Pi, Antigravity) on a
  **daemon** that lives on the user's own machine, or in a managed **cloud runtime**.
- Work is delivered through two surfaces: a **web app** (Next.js) and a **desktop app**
  (Electron, with tabbed multi-workspace navigation and a managed local daemon). (A mobile
  app formerly lived under `apps/mobile/`; it has been removed and is recoverable from
  git history.)

### Goals / constraints that shaped the design

- **Local-first agent execution.** The daemon owns the agent CLI process and its
  working directory; the server is a control plane that queues tasks and records
  results. This keeps secrets and source on the user's machine.
- **Installed-app resilience.** A desktop build on a user's laptop will outlive any
  given server build, so every API response is treated as a drifting contract (see
  §10).
- **Multi-tenant by construction.** Every workspace-scoped query filters by
  `workspace_id`; membership checks gate access.
- **Real-time by default.** WebSocket events keep the client cache fresh via
  invalidation — there is no polling.

---

## Quick start (development)

**Prerequisites:** Go 1.26+, Node 22, pnpm 10, and Docker (for the shared PostgreSQL).

```bash
make dev
```

One command: copies `.env.example` → `.env` (generates `JWT_SECRET`), starts the shared
`pgvector/pg17` Postgres container, installs deps, applies migrations, and runs the Go
server + the Next.js web app in the foreground. Stop with **Ctrl-C**.

- **Web:** http://localhost:3000 · **API:** http://localhost:8080 · **DB:** `multica` on localhost:5432
- **First login:** enter your email. With no `RESEND_API_KEY`/SMTP set, the 6-digit code
  is printed in the **backend logs** (or set `MULTICA_DEV_VERIFICATION_CODE` to pin it).
- **Run an agent locally** (optional — the dev server is the control plane): start the
  daemon against this server with `make daemon` (first `make cli ARGS="setup"` /
  `make cli ARGS="auth login"` to authenticate and register a runtime). Details in
  `CLI_AND_DAEMON.md`.

What `make dev` automates, exposed as separate targets:

```bash
cp .env.example .env     # then set JWT_SECRET / RESEND_API_KEY as needed
make setup               # pnpm install + ensure Postgres + migrate
make start               # ensure Postgres + migrate + run server + web (foreground)
make stop                # kill this checkout's backend + web
make check               # typecheck + TS tests (Vitest) + Go tests + Playwright E2E
make db-reset            # drop+recreate this checkout's DB and re-migrate (local only)
```

Other useful targets: `make server` (Go only), `pnpm dev:web` / `pnpm dev:desktop`
(frontend only), `make build` (server/CLI/migrate binaries → `server/bin/`), `make sqlc`
(regenerate DB code after editing `server/pkg/db/queries/*.sql`), `make cli ARGS="..."`
(run the `multica` CLI from source).

**Rebuild & restart the whole platform** (after pulling changes or editing Go code):

```bash
make stop                       # kill this checkout's backend + web
make build                      # rebuild server/CLI/migrate binaries → server/bin/
make start                      # ensure Postgres + migrate + run server + web (foreground)
```

`make start` blocks (it owns the server + web in the foreground), so run it in a dedicated
terminal or background it. While it runs, check the two surfaces:

```bash
curl -s localhost:8080/health    # → {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000   # → 200 (web)
```

Running desktop clients reconnect automatically over WebSocket once the backend is back.
`make build` is also the fastest way to confirm the Go tree compiles after a refactor —
the version is derived from `git describe` (a synthesized `v0.0.0-0-g<sha>` dev shape when
there are no tags, which still passes the CLI version gate).

**Worktrees:** every checkout shares one Postgres container; isolation is per-DB. In a
git worktree, `make worktree-env` generates `.env.worktree` (unique DB name + ports), then
`make setup-worktree` / `make start-worktree`. `make dev` auto-detects worktrees.

**Self-host (Docker — not for dev):** `make selfhost` (pull official GHCR images) or
`make selfhost-build` (build from the checkout). See `SELF_HOSTING*.md`.

---

## 2. System architecture at a glance

```
                         ┌─────────────────────────────────────────────┐
                         │                  Browser                    │
                         │  apps/web (Next.js App Router, SSR + CSR)  │
                         └───────────────┬─────────────────────────────┘
                                         │  REST (/api/*) + WS (/ws)
   ┌──────────────────────────────────────┼───────────────────────────────────┐
   │                                      │                                    │
┌──▼─────────────┐         ┌──────────────▼──────────────┐        ┌─────────────▼──────────┐
│  Desktop app   │         │      Multica server         │        │   Cloud Runtime Fleet  │
│ apps/desktop   │ ──────▶ │  (Go, Chi, :8080)            │ ──────▶ │  (multica-cloud, SaaS  │
│ Electron       │  REST+  │                              │ proxy   │   only; self-host 503) │
│ + bundled CLI  │  daemon │  ┌────────────────────────┐  │        └────────────────────────┘
│ + managed      │  WS     │  │ Handlers → Services    │  │
│  daemon        │         │  │ realtime.Hub (browser)│  │                 ┌────────────────────┐
└──────┬─────────┘         │  │ daemonws.Hub  (daemon) │  │ ── inbound ───▶ │  Lark Open Platform  │
       │ spawns            │  │ events.Bus (in-proc)   │  │   WS long-conn   │  (Feishu/Lark)       │
       │ multica           │  └───────────┬────────────┘  │                  └────────────────────┘
       │ daemon            │              │ Redis relay    │                 ┌────────────────────┐
       │ (foreground)      │              │ (multi-node)   │ ── webhook ───▶ │  GitHub App          │
┌──────▼─────────┐  claim/  │              │                │   HMAC           └────────────────────┐
│ Agent CLIs     │ ◀─────── │  ┌───────────▼────────────┐  │
│ claude/codex/… │  result  │  │  PostgreSQL (pgvector) │  │                 ┌────────────────────┐
│ + multica CLI  │ ───────▶ │  │  sqlc-generated queries │  │ ── proxy ─────▶ │ Cloud Billing /     │
│ (calls back to │          │  └────────────────────────┘  │                 │ Stripe (multica-   │
│  daemon+server)│          └──────────────────────────────┘                 │  cloud, SaaS only)  │
└────────────────┘                                                            └────────────────────┘
```

Key boundary insight: there are **two WebSocket hubs**, not one.

- `realtime.Hub` — serves **browser/desktop clients**. Clients subscribe to
  `workspace:{id}` and `user:{id}` rooms; the server broadcasts domain events.
- `daemonws.Hub` — serves **daemons**. Each daemon holds one persistent connection
  that receives `daemon:task_available` wakeups and reports heartbeat/task progress.
  Separate from the browser hub so daemon traffic cannot crowd out user-facing
  fanout, and so the Redis relay can route daemon wakeups on a dedicated scope
  (`daemon_runtime`).

---

## 3. Repository layout

```
multica/
├── server/                 # Go backend (Chi router, sqlc, gorilla/websocket)
│   ├── cmd/                # entrypoints: server, multica (CLI), migrate, backfill_task_usage_hourly
│   ├── internal/
│   │   ├── handler/        # HTTP handlers (the ~70 files above the service layer)
│   │   ├── service/        # domain services: task, issue, autopilot, email, builtin_skills
│   │   ├── realtime/       # browser WS hub + broadcaster + Redis relay (sharded/dual/legacy)
│   │   ├── daemonws/       # daemon WS hub + wakeup notifier
│   │   ├── events/         # in-process synchronous pub/sub Bus
│   │   ├── auth/           # JWT + PAT + cache (PATCache, DaemonTokenCache, MembershipCache)
│   │   ├── middleware/     # Auth, DaemonAuth, rate limiting, client metadata, CSP, request log
│   │   ├── metrics/        # Prometheus HTTP + business-event counters (sole analytics dispatch)
│   │   ├── analytics/      # typed Event model + constructors (PostHog transport removed)
│   │   ├── integrations/   # lark (inbound dispatcher, outbound cards, device-flow install)
│   │   ├── cloudruntime/   # SaaS fleet proxy client
│   │   ├── storage/        # local-only file storage (S3/CloudFront removed)
│   │   ├── scheduler/      # DB-backed distributed job runner (sys_cron_executions)
│   │   ├── agenttmpl/      # agent templates catalog
│   │   ├── skill/          # structured skills
│   │   ├── daemon/         # daemon-side runtime (the CLI's daemon subcommand, agent execution)
│   │   └── …               # issueguard, issueposition, logger, taskusagebackfill, util, etc.
│   ├── pkg/
│   │   ├── agent/          # unified Backend interface over 13 coding-agent CLIs + version gating
│   │   ├── db/             # sqlc config + queries/ + generated/ (the DB access layer)
│   │   ├── protocol/       # WS event name + message constants (shared by server + clients)
│   │   ├── redact/, taskfailure/   # cross-cutting helpers
│   ├── migrations/        # 120+ versioned SQL migrations (001..120)
│   └── data/               # local uploads root (default ./data/uploads)
├── apps/
│   ├── web/                # Next.js App Router (the browser app)
│   ├── desktop/            # Electron app (electron-vite): main / preload / renderer / shared
│   └── docs/               # docs site (the conventions source of truth)
├── packages/
│   ├── core/               # headless business logic + shared Zustand stores + API client (zero react-dom)
│   ├── ui/                 # atomic UI components over Base UI primitives (zero business logic)
│   ├── views/              # shared business pages/components (zero next/*, zero react-router)
│   └── tsconfig/           # shared TS config
├── e2e/                    # Playwright E2E (real browser + real backend)
├── docker/  *.yml  Dockerfile*  # self-host images
└── Makefile                # one-command dev/build/test/release
```

---

## 4. Backend (Go)

### 4.1 Boot sequence — `server/cmd/server/main.go`

1. **Config + warnings.** `logger.Init()`, then warns for missing `JWT_SECRET`, no
   email backend, and the dev verification-code escape hatch (ignored in production).
2. **DB pool.** `DATABASE_URL` (defaults to local `postgres://multica:multica@…`),
   `newDBPool` → `pool.Ping`.
3. **Realtime core.**
   - `events.New()` — in-process synchronous Bus.
   - `realtime.NewHub()` → `go hub.Run()` — browser WS hub.
   - `daemonws.NewHub()` — daemon WS hub; `daemonWakeup` defaults to the hub itself.
4. **Redis relay (optional, multi-node).** When `REDIS_URL` is set, realtime fanout
   routes through a Redis relay so multiple API nodes deliver each other's events.
   Three modes via `REALTIME_RELAY_MODE`: `sharded` (default, per-scope streams +
   XREADGROUP with on-demand consumer loops), `legacy` (single pub/sub), `dual`
   (mirrored, migration aid). The broadcaster becomes a `DualWriteBroadcaster`
   (local fast path + cross-node publish, ULID-deduped). Separate Redis clients for
   *store* (request path) vs *realtime read/write* so a blocking stream consumer can't
   starve request-path ops.
   - When `REDIS_URL` is unset the hub is the sole broadcaster and the server is
     single-node.
5. **Listeners.** `registerListeners(bus, broadcaster)` maps domain events → WS
   broadcast. Subscriber listeners register **before** notification listeners
   (notifications query the subscriber table, so subscribers must be written first in
   the same synchronous dispatch).
6. **Metrics.** `obsmetrics.ConfigFromEnv()` — if enabled, builds a registry (HTTP
   metrics, business metrics, a dedicated sampler pgxpool so a stalled scrape can't
   starve business traffic), wires the daemon WS message-kind recorder, and starts a
   separate metrics HTTP server (loopback-only by default; warns if not).
7. **Router + handler.** `NewRouterWithOptions(pool, hub, bus, storeRedis, opts)`
   builds the Chi router and returns the `*handler.Handler` (so `main.go` can drive
   background lifecycle on the services it owns — e.g. starting the Lark Hub).
8. **Background workers** (each under a cancel context):
   - `runRuntimeSweeper` — marks stale daemon runtimes offline.
   - `heartbeatScheduler.Run` — batched heartbeat bumps (injected into the handler).
   - `runAutopilotScheduler` — polls DB for due autopilot triggers and fires runs.
   - `runAutopilotFailureMonitor` — surfaces stuck/failed autopilot runs.
   - `runDBStatsLogger` — periodic pool stats logging.
   - `LarkHub.Run` — per-installation inbound WS supervisor (nil when Lark key unset).
   - `scheduler.Manager` — DB-backed distributed job runner; first job is
     `rollup_task_usage_hourly`.
9. **Serve.** `srv.ListenAndServe()` on `:PORT` (default 8080).
10. **Graceful shutdown.** SIGINT/SIGTERM → `autopilotCancel` → drain HTTP (10s) →
    `sweepCancel` + `heartbeatScheduler.Stop()` (flush pending bumps) → join Lark Hub
    supervisors (bounded wait) → stop metrics server (3s).

### 4.2 Router — `server/cmd/server/router.go`

Chi router with global middleware in order:

```
RequestID → ClientMetadata → RequestLogger → HTTPMetrics → Recoverer →
ContentSecurityPolicy → CORS
```

- CORS origins from `CORS_ALLOWED_ORIGINS`/`FRONTEND_ORIGIN`, shared with the WS
  origin checker. `MULTICA_TRUSTED_PROXIES` is shared between CORS and the WS origin
  check so X-Forwarded-Host is honored from one config source.

Route groups:

- **Health:** `/health`, `/readyz`, `/healthz`, `/health/realtime` (token-gated or
  loopback-only).
- **WebSocket:** `/ws` (browser) via `realtime.HandleWebSocket`.
- **Static uploads:** `/uploads/*` served from local storage.
- **Auth (public, per-IP rate-limited):** `/auth/send-code`, `/auth/verify-code`,
  `/auth/google`, `/auth/logout`.
- **Public API:** `/api/config`, `/api/contact-sales`.
- **Webhook ingress (no Multica auth — credential is the signature/URL token):**
  `/api/webhooks/autopilots/{token}` (bearer token in path), `/api/webhooks/github`
  (HMAC), `/api/github/setup`, `/api/webhooks/stripe`.
- **`/api/daemon/*`** — `middleware.DaemonAuth` (daemon token or valid user token):
  register/deregister/heartbeat, `/ws` (daemon WS), task claim/pending/start/
  progress/complete/fail/usage/messages, `*-gc-check` (orphan reclamation),
  recover-orphans, pin-session.
- **`Auth` group** (JWT/PAT):
  - **User-scoped** (no workspace): `/api/me`, onboarding (incl. deprecated
    `*_bootstrap` shim routes for pre-v3 desktop), `/api/cli-token`, `/api/upload-file`,
    `/api/feedback`, `/api/attachments/{id}/download` (registered outside the
    workspace group so it can be a native `<img>`/`<video>` src without workspace
    headers — handler self-resolves the workspace from the attachment row),
    `/api/workspaces/*` (member/admin/owner role tiers), `/api/invitations/*`,
    `/api/tokens/*` (PATs), `/api/cloud-billing/*` (SaaS, `RequireHumanActor` blocks
    task-token actors), `/api/lark/binding/redeem`.
  - **Workspace-scoped** (`middleware.RequireWorkspaceMember`): the bulk of the
    product — issues, tasks, labels, projects, squads, autopilots, pins, attachments,
    comments, agents, agent-templates, skills, dashboard, runtimes, cloud-runtime
    fleet proxy, chat, inbox, notification-preferences.

### 4.3 Handler + services — `server/internal/handler/handler.go`

`Handler` is the single dependency hub holding: `Queries` (sqlc), `DB`/`TxStarter`
(pool), `Hub` (browser WS), `DaemonHub`, `Bus` (events), the three domain services
(`TaskService`, `IssueService`, `AutopilotService`), `EmailService`, assorted
in-memory-or-Redis stores (Update, ModelList, LocalSkillList/Import, Liveness,
HeartbeatScheduler), `Storage`, `Metrics` (nil-safe), auth caches, webhook rate
limiters, the cloud-runtime proxy, and the entire Lark integration surface
(`LarkInstallations`, `LarkBindingTokens`, `LarkRegistration`, `LarkAPIClient`,
`LarkHub` — all nil unless `MULTICA_LARK_SECRET_KEY` is set, in which case the Lark
handlers return 503).

`handler.New(...)` constructs the three services wired together:
`TaskService(queries, txStarter, hub, bus, daemonHub)` →
`IssueService(queries, txStarter, bus, taskSvc)` →
`AutopilotService(queries, txStarter, bus, taskSvc)`. The router then layers in
metrics, the daemon wakeup notifier, Redis-backed stores (when `rdb != nil`), auth
caches, and the cloud PAT verifier.

### 4.4 Realtime + events — the two-axis fanout model

Two cooperating mechanisms carry state changes from server to clients:

- **`events.Bus`** — in-process synchronous pub/sub (`server/internal/events/bus.go`).
  Domain code publishes typed events (`issue:created`, `task:completed`, …); listeners
  (registered in `main.go` + `cmd/server/*_listeners.go`) react: broadcast to WS,
  write activity log, fan out inbox notifications. Handlers run in registration order;
  panics in one listener are recovered so others still run. The ordering invariant
  (subscribers before notifications) matters because notifications query the
  subscriber table within the same synchronous dispatch.
- **`realtime.Hub` / `Broadcaster`** — scope-based WS rooms. The `Broadcaster`
  interface (`BroadcastToScope`, `BroadcastToWorkspace`, `SendToUser`, `Broadcast`)
  is the abstraction producers depend on instead of `*Hub`. Scopes: `workspace`,
  `user`, `task`, `chat`, `daemon_runtime`. Slow clients (full send channel) are
  evicted under write lock; `onFirstSubscriber`/`onLastSubscriber` callbacks let the
  Redis relay start/stop per-scope consumer loops on demand. `DualWriteBroadcaster`
  fans out locally *and* to the Redis relay with ULID event IDs so the loopback
  doesn't double-deliver to the originating client.

So the canonical path for, e.g., "agent completed an issue": the daemon calls
`POST /api/daemon/tasks/{id}/complete` → `TaskService` marks the task done → publishes
`task:completed` on the Bus → a listener broadcasts `task:completed` via the
`Broadcaster` to the `workspace` scope → browser/desktop clients' WS receives it →
the frontend invalidates the relevant TanStack Query (never writes to a store).

### 4.5 Data access — sqlc + migrations

- **Migrations:** `server/migrations/`, currently 120 numbered pairs
  (`NNN_name.up.sql` / `.down.sql`). Run via `go run ./cmd/migrate up|down`.
- **Queries:** authored in `server/pkg/db/queries/*.sql`; `make sqlc` regenerates
  `server/pkg/db/generated/`. All DB access in handlers/services goes through
  `*db.Queries` (sqlc-generated, type-safe).
- **Multi-tenancy:** every workspace-scoped query filters by `workspace_id`;
  membership checks gate access (the `RequireWorkspaceMember` /
  `RequireWorkspaceRoleFromURL` middleware resolve the member and role into context
  before handlers run).
- **pgvector** (`pgvector/pgvector:pg17` image) — the shared PostgreSQL carries
  vector support for embeddings used by search.

### 4.6 Storage — local-only

`server/internal/storage` is local-filesystem only. Attachments write under
`LOCAL_UPLOAD_DIR` (default `./data/uploads`) and are served from `/uploads/*` and
`/api/attachments/{id}/content`. S3/CloudFront/SecretsManager were removed in `e3d2c2aa`;
the multi-backend `Storage` interface now has a single implementation (`LocalStorage`).
Downloads (`/api/attachments/{id}/download`) always **proxy** through the server — they
stream via `Storage.GetReader` — so there is no presign/redirect mode or signed-URL TTL
anymore. Download endpoints self-resolve the workspace from the attachment row and enforce
membership inside the handler.

### 4.7 Auth

- **Send-code flow:** `POST /auth/send-code` (rate-limited per IP, 1 code/email/60s)
  → `checkSignupAllowed` (existing users always allowed; new users gated by
  `ALLOW_SIGNUP` + `ALLOWED_EMAILS` + `ALLOWED_EMAIL_DOMAINS`) → 6-digit code stored in
  `verification_code` (10-min expiry) → emailed via Resend or SMTP (or logged when
  neither configured; `MULTICA_DEV_VERIFICATION_CODE` dev escape hatch, ignored in
  production).
- **Verify-code flow:** `POST /auth/verify-code` → constant-time compare →
  `MarkVerificationCodeUsed` → `findOrCreateUser` → `issueJWT` → set HttpOnly auth
  cookie + CSRF cookie → return token + user.
- **Google OAuth:** `POST /auth/google`.
- **Tokens:** JWT (browser cookie / desktop), Personal Access Tokens (`mul_`…
  hashed, cached via `PATCache`), daemon tokens (`mdt_`), task-scoped tokens
  (`mat_`… so an agent can comment/claim as its owner — but `RequireHumanActor`
  blocks task tokens from billing endpoints to prevent lateral movement), and Cloud
  PATs (`mcn_`… verified against Multica Cloud Fleet). `Auth` / `DaemonAuth`
  middlewares resolve the actor and stamp `X-User-ID` / `X-Actor-Source`.

---

## 5. The agent runtime model

This is the heart of the product: how an AI agent actually does work.

### 5.1 Two execution venues

- **Local daemon.** `multica daemon start --foreground` runs on the user's machine
  (the desktop app manages this process; a standalone CLI can too). The daemon holds
  one persistent WS to the server (`/api/daemon/ws`), claims queued tasks, spawns the
  configured coding-agent CLI as a subprocess in an isolated per-task working
  directory, and reports progress/results back. **Secrets and source stay local.**
- **Cloud runtime.** A managed fleet (SaaS only; self-host returns 503). Proxied via
  `/api/cloud-runtime/*` to multica-cloud's Fleet service. Workdirs are preserved in
  cloud mode for session reuse across tasks on the same (agent, issue) pair.

### 5.2 The unified agent `Backend` — `server/pkg/agent/agent.go`

```
type Backend interface {
    Execute(ctx, prompt, ExecOptions) (*Session, error)
}
```

`agent.New(agentType, Config)` dispatches to one of 6 backends (claude, codex,
copilot, opencode, pi, cursor). Each backend wraps a vendor CLI's native streaming
protocol (stream-json, ACP, app-server stdio, etc.) and emits a unified `Message`
stream (text/thinking/tool-use/tool-result/status/error/log) plus a final `Result`
(completed/failed/aborted/timeout/cancelled + per-model `TokenUsage`). `Session` =
`Messages <-chan Message` + `Result <-chan Result`.

`ExecOptions` carries: `Cwd` (isolated workdir), `Model`, `SystemPrompt` (only for
providers that can pass or safely inline developer/system instructions),
`ThreadName`, `Timeout` / `SemanticInactivityTimeout`, `ResumeSessionID`,
`ExtraArgs`/`CustomArgs`, `McpConfig`, `ThinkingLevel`, `SettingsPath`.

### 5.3 Task execution flow — `server/internal/daemon/daemon.go`

`Daemon.runTask` is the canonical path:

1. Refuse to spawn without a `workspace_id` (would leak ops into an unrelated
   workspace when one host serves multiple workspaces).
2. Register the task's repos into the per-workspace allowlist/cache.
3. Build the task context (issue id, trigger comment, agent identity/instructions/
   skills, repos, project resources, autopilot context, quick-create marker, squad
   leader flag, requester profile, workspace context).
4. **Prepare the workdir.** `execenv.Reuse` (prior task on same (agent, issue) pair →
   resume the workdir + session) or `execenv.Prepare` (fresh isolated dir, writes
   CLAUDE.md/AGENTS.md/.agent_context/, per-provider sidecars, MCP config). Marks
   candidate env roots active so the GC loop can't reclaim them mid-execution.
5. `client.StartTask` (transition dispatched/waiting_local_directory → running) —
   done *after* the workdir exists on disk to close a race where a reader hit
   `running` before `MkdirAll` finished.
6. Inject `MULTICA_TOKEN` (task-scoped, bound to (agent, task) — never the daemon's
   own credential, which would let agent writes land as the runtime owner and
   retrigger the same agent), `MULTICA_SERVER_URL`, `MULTICA_DAEMON_PORT`,
   `MULTICA_WORKSPACE_ID`, agent/task/slot ids, autopilot ids, quick-create marker,
   and prepend the running binary's dir to `PATH` so `multica` resolves inside
   sandboxed runtimes. Per-provider env (`CODEX_HOME`, `CURSOR_DATA_DIR`,
   `OPENCLAW_CONFIG_PATH`, …) and user-configured `custom_env` (blocklisted keys
   skipped) are layered in.
7. Resolve the model (explicit agent model → daemon-wide `MULTICA_<PROVIDER>_MODEL` →
   "" so the CLI picks its own default; a Go-side default is deliberately avoided
   because static guesses drift from the upstream CLI). Validate `thinking_level`
   per-model (fail open: stale persisted values never block execution).
8. `agent.New(provider, …)` → `executeAndDrain` (runs the backend, drains the message
   stream, reports progress to the server as it goes).
9. On resume failure with no session established, retry with a fresh session.
10. In `local_directory` mode (agent runs in the user's own repo), excise the runtime
    brief + sidecars on the way out so the user's tree doesn't accumulate per-task
    cruft and a later manual CLI run doesn't pick up stale Multica instructions.

The spawned agent CLI calls back into Multica via `multica issue status`,
`multica issue comment add`, `multica repo checkout`, etc. — authenticated with the
task-scoped token. So the agent's *actions* on issues are normal API calls, not
special daemon RPCs.

### 5.4 Daemon lifecycle

- **Register:** `POST /api/daemon/register` — the daemon identifies itself, reports
  its `cli_version` (the CLI binary's `main.version`, set via ldflags from
  `git describe`), the installed agent CLIs + their versions. `MinVersions`
  (`server/pkg/agent/version.go`) gates per-provider minimums (claude 2.0.0, codex
  0.100.0, copilot 1.0.0); below-minimum registration is rejected.
- **Heartbeat:** `POST /api/daemon/heartbeat` (batched by `BatchedHeartbeatScheduler`)
  + WS heartbeat frames keep liveness. `LivenessStore` (Redis when configured, else
  noop) and the sweeper agree on the same store choice — if they disagree, online
  runtimes get falsely marked offline.
- **Sweeper:** `runRuntimeSweeper` marks runtimes that haven't heartbeated as offline.
- **Wakeup:** when a task is queued for a runtime, the server sends a
  `daemon:task_available` frame (directly via the hub, or via the Redis relay's
  `daemon_runtime` scope in multi-node mode) so the daemon polls for the task
  promptly instead of on its poll interval.
- **Deregister:** `POST /api/daemon/deregister`.

### 5.5 The CLI version gate (quick-create)

`server/pkg/agent/version.go` `MinQuickCreateCLIVersion = "0.2.21"` gates the
agent-create ("quick create") flow against the daemon's reported `cli_version`.
`CheckMinCLIVersion` returns `ErrCLIVersionMissing` (empty/unparsable),
`ErrCLIVersionTooOld`, or nil. A **dev-describe escape hatch**
(`^v?\d+\.\d+\.\d+-\d+-g[hex]`, the `git describe` shape past a tag) always passes so
`make build`/`make daemon` from source stays unblocked. The frontend mirror lives in
`packages/core/runtimes/cli-version.ts` (`DEV_DESCRIBE_RE`, `checkQuickCreateCliVersion`
→ "missing"/"too_old"/"ok"). A repo with no git tags must synthesize the dev-past-tag
shape (`v0.0.0-0-g<sha>`) or the gate rejects it as "missing" — this is exactly what
the Makefile + `bundle-cli.mjs` version derivation guarantees.

### 5.6 Autopilot

`server/internal/service/autopilot.go` + `server/internal/handler/autopilot.go`.
Autopilots are scheduled/triggered agent runs. Trigger kinds include webhook (the
bearer-token URL path above) and others; `runAutopilotScheduler` polls for due
triggers, `runAutopilotFailureMonitor` surfaces stuck runs. A run creates an issue and
queues a task on the (squad leader's) runtime via `TaskService`. Trigger rows carry a
webhook token + optional signing secret; deliveries are audited in `webhook_delivery`
and replayable.

### 5.7 Squads

A **squad** is a group of agents (`squad` + `squad_member` tables) with member roles;
the squad **leader** is the runtime that autopilot/chained runs dispatch to.
Squad-member status is derived from each agent's most recent terminal task.

### 5.8 Skills + agent templates

- **Skills** (`skill` + `skill_file`): structured, versioned instruction bundles an
  agent loads. Built-in skills live in `server/internal/service/builtin_skills/*` as
  **source-traced contracts** — each ships a `SKILL.md` + `references/*-source-map.md`
  that pin the CLI commands/flags/API fields the skill teaches. When code moves, the
  skill must move with it in the same PR or it silently teaches stale behavior.
- **Agent templates** (`agenttmpl`): pre-configured instructions + skill refs; picking
  one imports the referenced skills (find-or-create by name) and creates the agent with
  the template's instructions in one transaction.

---

## 6. Frontend (shared packages + web)

### 6.1 The internal-packages pattern

All shared packages export **raw `.ts`/`.tsx`** (no pre-compilation); the consuming
app's bundler compiles them directly. Zero-config HMR, instant go-to-definition.
Dependency direction: `views → core + ui`. Core and UI are independent of each other.
Nothing in a package imports `next/*`, `react-router-dom`, or app-specific code.

- `packages/core/` — headless business logic. **Zero react-dom, zero localStorage
  (use `StorageAdapter`), zero `process.env`, zero UI libs.** Shared Zustand stores
  live here (auth, workspace, filters/view modes, tabs, window-overlay) — even
  view-related ones, because stores are pure state, not UI.
- `packages/ui/` — atomic components over Base UI primitives (`@base-ui/react`, not
  Radix). Semantic design tokens (`bg-background`, `text-muted-foreground`); shared
  styles in `packages/ui/styles/`. Zero `@multica/core` imports.
- `packages/views/` — shared business pages/components per domain (issues, settings,
  runtimes, autopilots, agents, chat, inbox, onboarding, layout, …). Zero `next/*`,
  zero `react-router-dom`, zero stores. All routing goes through `NavigationAdapter`.

### 6.2 State management — the hard split

This is the architecture's load-bearing rule. Mixing server and client state is the
most common way to break it.

- **TanStack Query owns all server state.** Issues, users, workspaces, inbox —
  anything fetched from the API lives in the Query cache. WS events keep it fresh via
  **invalidation**; no polling, no `staleTime` workarounds.
- **Zustand owns all client state.** UI selections, filters, drafts, modal state,
  navigation history. Stores live in `packages/core/`.
- **React Context** is reserved for cross-cutting plumbing (`WorkspaceIdProvider`,
  `NavigationProvider`).

Hard rules:

- Never duplicate server data into Zustand (two sources of truth → drift).
- Workspace-scoped queries key on `wsId` — switching workspace changes the cache key
  and the right data appears, no manual invalidation.
- Mutations are **optimistic by default** — apply locally, send, roll back on
  failure, invalidate on settle.
- **WS events invalidate queries; they never write to stores directly.** Keeps the
  cache the single source of truth, avoids races.
- Persist what's worth keeping across restarts (prefs, drafts, tab layout); don't
  persist ephemeral UI state or server data.
- Auth + workspace stores are the *only* stores allowed to call `api.*` directly.
- Selectors must return stable references (no freshly-built objects/arrays per call —
  infinite re-renders).

### 6.3 API client + the parse-don't-cast contract — `packages/core/api/`

`ApiClient` (`client.ts`) is the single HTTP surface; `setApiInstance` registers the
module singleton. The defining rule (see also `CLAUDE.md`):

> A desktop build on a user's machine is older than any backend it talks to. Every
> response shape is a contract that **will** drift, and the frontend must survive
> drift without white-screening.

So every endpoint whose response feeds UI logic runs through `parseWithFallback(raw,
zodSchema, typedFallback)` in `schema.ts` — validates, logs a warning on mismatch,
returns the fallback, **never throws into the UI**. `schemas.ts` holds the zod schemas
+ typed `EMPTY_*` fallbacks. Downstream code treats every field as possibly missing
and uses explicit `=== true` checks. `switch` statements on server-driven strings have
a `default` (enum drift downgrades, doesn't crash). A UI affordance never depends on
exactly one backend boolean — signals are combined. When you add/change an endpoint,
add the schema + a malformed-response test in the same PR.

### 6.4 Platform layer — `packages/core/platform/`

`CoreProvider` is the boot sequence shared by web and desktop. On first render it
`initCore`: constructs the `ApiClient`, sets the singleton, hydrates the token from
storage (or cookie mode), creates + registers the auth and chat Zustand stores. Then
it nests:

```
I18nProvider
└─ QueryProvider          (TanStack Query QueryClient)
   └─ AuthInitializer     (restores session, refreshes on unauthorized)
      └─ WSProvider        (WSClient — reconnects in 3s, dedups via event_id)
         └─ children
```

`StorageAdapter` (`getItem`/`setItem`/`removeItem`) abstracts localStorage (web) vs
Electron persistent storage (desktop) so `core/` stays DOM-free. `NavigationAdapter`
abstracts routing — web wraps `next/navigation`, desktop wraps its memory router; shared
code calls `useNavigation().push()` / `<AppLink>`, never framework APIs. The freeze
watchdog (`diagnostics/`) mounts once in `CoreProvider` for both apps.

### 6.5 Realtime client — `packages/core/api/ws-client.ts`

`WSClient`: connects to `/ws`, sends `client_platform`/`client_version`/`client_os` +
`workspace_slug` as query params (browsers can't set WS headers). Token-mode sends the
token as the first message after open (never as a query param — it'd land in logs/
history); cookie-mode relies on the HttpOnly cookie. Reconnects in 3s on close.
Dispatches typed `WSEventType` frames to registered handlers; `onReconnect` fires
reconnect callbacks so queries can refetch. WS event types come from
`server/pkg/protocol` (see §9) — the server and all clients share one constant set.

### 6.6 Web app — `apps/web/`

Next.js App Router. Route structure under `apps/web/app/`:

- `(auth)` group — `login`, `onboarding`, `workspaces`, `invitations`, `invite`.
- `(landing)` group — marketing pages (`homepage`, `about`, `usecases`, `download`,
  `changelog`, `contact-sales`).
- `[workspaceSlug]/(dashboard)/` — the workspace-scoped app; the slug layout resolves
  the slug → `setCurrentWorkspace(slug, wsId)` on mount.
- `auth/callback` — Google OAuth.
- `lark/bind` — Lark binding-token redemption page.

`apps/web/platform/` is the **only** place `next/navigation` is imported. `proxy.ts`
runs edge redirects + (after the i18n cleanup) plain `NextResponse.next()` — the
legacy URL/root redirects are live and preserved; the multi-locale header forwarding
was removed. The web app wraps shared views from `@multica/views` and provides
Next-specific wiring (cookies, searchParams, SSR). It is CSR-only in practice for the
dashboard, so a fix ships in minutes.

---

## 7. Desktop app (Electron) — `apps/desktop/`

electron-vite. Four layers:

- **main** (`src/main/`): the Node process. `index.ts` boots the app — single-instance
  lock, window/tab management, context menu, keyboard shortcuts, navigation gestures,
  renderer recovery. `daemon-manager.ts` runs the **bundled `multica` CLI** in
  `daemon start --foreground` mode, restarted on profile changes; it falls back to
  auto-installing the latest release at runtime if the bundled binary is absent
  (`cli-bootstrap.ts` / `cli-release-asset.ts`). `updater.ts` wires electron-updater
  (the live surface: `onUpdateDownloaded`, `installUpdate`, `checkForUpdates`). The
  renderer config is loaded via `runtime-config-loader.ts` (which reads the backend
  `/api/config`).
- **preload** (`src/preload/`): the typed IPC bridge exposing `DesktopAPI`,
  `DaemonAPI`, `UpdaterAPI` to the renderer via contextBridge. The dead
  system-locale chain + unused updater/log IPC were removed in the simplify pass.
- **renderer** (`src/renderer/`): a Vite React app that imports `@multica/core`,
  `@multica/ui`, `@multica/views` exactly like the web app. Its own memory router +
  `DesktopNavigationProvider` (the `NavigationAdapter` impl), per-tab
  `WorkspaceRouteLayout`, tab store, window-overlay store.
- **shared** (`src/shared/`): types shared between main + renderer.

### 7.1 Desktop-only constraints (each from a concrete bug)

- **Route categories.** Every path is exactly one of:
  - **Session routes** — `/:slug/*` workspace pages, rendered by the per-tab memory
    router under `WorkspaceRouteLayout`. Legitimate tab destinations.
  - **Transition flows** — pre-workspace/one-shot actions (create workspace, accept
    invite). **Not routes.** They live as `WindowOverlay` state; the navigation
    adapter translates `push('/workspaces/new')` / `push('/invite/<id>')` into an
    overlay, not a router navigation. The shared view (`NewWorkspacePage`,
    `InvitePage`) is identical to web — only the chrome wrapper differs.
  - **Error/stale states** — "workspace not available," tabs pointing at a revoked
    workspace. **Not pages.** `WorkspaceRouteLayout` auto-heals by dropping the stale
    tab group; the user never lands on an explicit error screen (no URL bar, so stale
    = heal silently).
- **Workspace context.** `setCurrentWorkspace(slug, uuid)` is the single source of
  truth; set on mount, *not* cleared on unmount. Code that leaves workspace context
  (leave/delete, force-navigate to overlay) must call `setCurrentWorkspace(null, null)`
  explicitly.
- **Tab isolation.** Tabs are grouped per workspace in `tab-store.ts`; the TabBar
  shows only the active workspace's tabs — cross-workspace leakage is impossible by
  construction. Cross-workspace `push(path)` is detected by the navigation adapter and
  translated into `switchWorkspace(slug, targetPath)`, never an in-tab navigation.
- **Destructive op order** (leave/delete workspace): read destination from cached
  workspace list → `setCurrentWorkspace(null, null)` → `navigation.push(destination)`
  → `await mutation.mutateAsync(workspaceId)`. Any other order races concurrent
  refetches and forces a renderer hard-reload.
- **Drag region (macOS).** Every full-window desktop view mounts `<DragStrip />` as
  the first flex child of the page root, or the window isn't draggable. Interactive UI
  in the top 48px needs `WebkitAppRegion: "no-drag"`.

### 7.2 The bundled CLI

`apps/desktop/scripts/bundle-cli.mjs` builds `multica` from `server/cmd/multica` with
ldflags mirroring `make build` (version = `git describe --tags --dirty`, falling back
to a synthesized `v0.0.0-0-g<sha>` dev shape when there are no tags) and copies it to
`resources/bin/` so electron-vite (dev) and electron-builder (prod) pick it up. On
macOS the binary is ad-hoc codesigned. **A binary hot-swapped into a signed `.app`
breaks the hardened-runtime seal and gets SIGKILLed** — to update the bundled CLI you
must repackage via electron-builder, not swap the file in place.

---

## 8. Data model

120+ migrations. Core tables (grouped):

- **Tenancy & identity:** `workspace`, `member`, `workspace_invitation`,
  `verification_code`, `personal_access_token`, `daemon_token`, `notification_preference`.
- **Issues & workflow:** `issue`, `issue_dependency`, `issue_label`/`issue_to_label`,
  `issue_subscriber`, `issue_reaction`, `issue_pull_request`, `issue_metadata`,
  `comment`, `comment_reaction`, `pinned_item`, `project`, `project_resource`,
  `label`, `activity_log`, `inbox_item`.
- **Agents & execution:** `agent`, `agent_runtime`, `agent_skill`, `skill`,
  `skill_file`, `agent_task_queue`, `task_token`, `task_message`,
  `runtime_usage`, `task_usage` (+ hourly/daily/rollup variants + dashboard rollups),
  `daemon_connection`, `daemon_pairing_session`.
- **Squads & autopilot:** `squad`, `squad_member`, `autopilot`, `autopilot_trigger`,
  `autopilot_run`, `webhook_delivery`.
- **Chat:** `chat_session`, `chat_message`.
- **Attachments:** `attachment`.
- **Integrations:** `github_installation`, `github_pull_request`,
  `github_pull_request_check_suite`, `lark_installation`, `lark_user_binding`,
  `lark_binding_token`, `lark_chat_session_binding`, `lark_inbound_audit`,
  `lark_inbound_message_dedup`, `lark_outbound_card_message`.
- **Scheduler:** `sys_cron_executions`.
- **Misc:** `feedback`, `contact_sales_inquiry`.

Assignees are **polymorphic**: `assignee_type` + `assignee_id` on issues (member or
agent).

---

## 9. Realtime event protocol — `server/pkg/protocol`

One shared constant set for the server and all clients (`events.go` + `messages.go`).
Domain event types (a representative slice):

```
issue:created | issue:updated | issue:deleted | issue_labels:changed |
issue_metadata:changed | issue_reaction:added | issue_reaction:removed
task:queued | task:dispatch | task:running | task:progress | task:message |
task:cancelled | task:completed | task:failed | task:waiting_local_directory
comment:created | comment:updated | comment:deleted | comment:resolved | comment:unresolved
agent:created | agent:archived | agent:restored | agent:status
runtime_gone | runtimes
squad:created | squad:updated | squad:deleted
autopilot:created | autopilot:updated | autopilot:deleted |
autopilot:run_start | autopilot:run_done
chat:message | chat:done | chat:session_updated | chat:session_read | chat:session_deleted
inbox:new | inbox:read | inbox:archived
member:added | member:updated | member:removed
workspace:updated | workspace:deleted
lark_installation:created | lark_installation:revoked
daemon:task_available
```

Frames carry `{type, payload, actor_id, actor_type, event_id}`. `event_id` (ULID) is
the dedup key for the dual-write/relay loopback path.

---

## 10. Integrations

- **Lark (Feishu/Lark Suite)** — `server/internal/integrations/lark`. Opt-in via
  `MULTICA_LARK_SECRET_KEY` (at-rest secretbox key; handlers 503 when unset). Two
  directions:
  - **Inbound:** per-installation WS long-conn supervisor (`LarkHub`) holds the §4.4
    lease and runs the `Dispatcher` (identity resolution → dedup → append →
    /issue → enqueue, debounced per chat session). Inbound enricher prefetches group
    history into the agent brief. Region-aware (open.feishu.cn vs larksuite.com).
  - **Outbound:** `Patcher` posts/patches interactive cards (the "agent is working"
    typing indicator → reply card); `OutcomeReplier` translates NeedsBinding /
    AgentOffline / AgentArchived into Lark reply cards. Device-flow (RFC 8628)
    QR-scan install via `RegistrationService` against accounts.feishu.cn.
- **GitHub App** — HMAC-SHA256-signed webhooks (`/api/webhooks/github`); connect via
    OAuth flow (`/github/connect`); per-workspace installation; pull-request linkage to
    issues. Member-visible listing, admin-only connect/disconnect.
- **Cloud Billing / Stripe** — SaaS only, proxied to multica-cloud's Billing service;
    `RequireHumanActor` blocks task-token actors (a running agent must not read its
    owner's balance). Stripe webhook is the public outlier (forwards the raw body +
    Stripe-Signature).
- **Cloud Runtime Fleet** — SaaS only; `/api/cloud-runtime/*` proxies node lifecycle
    (start/stop/reboot/status/exec) to multica-cloud's Fleet; self-host returns 503.

---

## 11. Observability — `server/internal/metrics`

After the PostHog transport removal, **`metrics.RecordEvent(m, ev)` is the single
analytics dispatch site.** `analytics.Event` + typed constructors survive (consumed by
the metrics layer); the PostHog shipping client does not.

- **HTTP metrics** — request latency/status via the Chi middleware.
- **Business-event counters** — typed Prometheus counters per `analytics.Event*`
  constant, with **label normalizers** (`NormalizePlatform`, `NormalizeSignupSource`,
  `NormalizeAutopilotCadence`, …) that collapse unknown values to a fixed fallback
  bucket (e.g. an unrecognized `X-Client-Platform` header collapses to `unknown`,
  preventing label-cardinality inflation). Two lint tests enforce the contract:
  `business_pairing_test.go` (every `Event*` constant has a paired counter; every
  `RecordEvent` call site takes an `analytics.*` helper, never a bare value) and
  `labels_pr3_test.go` (normalizer fallback regressions).
- **Realtime/daemon-WS metrics** — connection counts, slow evictions, per-event send
  QPS, daemon frame-kind split.
- A dedicated sampler pgxpool feeds the business sampler so a stalled scrape can't
  starve business traffic. Metrics server is loopback-only by default.

---

## 12. Infrastructure, CI, release

- **Local dev.** `make dev` auto-creates env, installs deps, starts the shared
  PostgreSQL (`pgvector/pgvector:pg17`), migrates, and launches backend + web. One
  shared PG container; isolation is at the DB level — worktrees get their own DB name
  + ports via `.env.worktree` (`make worktree-env`).
- **Build.** `make build` → server/CLI/migrate binaries into `server/bin/` with
  ldflags (version/commit/date from `git describe`). Desktop `pnpm --filter
  @multica/desktop build` + `package`; `bundle-cli.mjs` runs on every dev/build/package
  so the bundled CLI always matches current Go source.
- **Check.** `make check` = typecheck + TS unit (Vitest) + Go tests + Playwright E2E.
- **CI** (`.github/workflows/ci.yml`): Node 22, Go 1.26.1, `pgvector/pgvector:pg17`
  service. Desktop smoke build in CI.
- **Self-hosting.** `docker-compose.selfhost.yml` (+ `.build.yml` to build from
  checkout); `make selfhost` pulls official GHCR images or `make selfhost-build`
  builds locally; generates random `JWT_SECRET` + `POSTGRES_PASSWORD`.
- **CLI release (must accompany every Production deploy).** Tag `main` with
  `v0.x.x` → `git push origin v0.x.x` → `release.yml` runs Go tests → GoReleaser builds
  multi-platform binaries → publishes to GitHub Releases + the Homebrew tap
  (`multica-ai/tap/multica`). Bump patch by default.

---

## 13. Cross-cutting decisions worth remembering

- **Two WS hubs on purpose** — browser fanout and daemon wakeups are separate so
  daemon traffic can't crowd user-facing delivery and so the Redis relay can route
  daemon wakeups on a dedicated scope.
- **Server = control plane, daemon = execution plane.** The server queues tasks and
  records results; the daemon owns the agent CLI process, workdir, secrets, and
  source. The agent's *actions* on issues are ordinary API calls made with a
  task-scoped token.
- **Task-scoped auth, never daemon auth.** `MULTICA_TOKEN` is bound to (agent, task);
  it never falls back to the daemon's own credential, which would let agent writes
  land as the runtime owner and retrigger the same agent. Billing endpoints block
  task-token actors entirely.
- **parse-don't-cast is the only defense for an installed-app architecture.** A CSR
  browser app can ship a fix in minutes; an Electron build on a laptop cannot. So
  every response is validated with a fallback and never throws into the UI.
- **Internal packages + strict dependency direction** keep web and desktop sharing one
  business layer with zero-config HMR and instant go-to-definition. (A mobile app formerly
  shared types + pure functions only; it has been removed.)
- **One reserved-slug list, generated.** `server/internal/handler/reserved_slugs.json`
  is the source; `packages/core/paths/reserved-slugs.ts` is generated from it and CI
  fails on drift. Global routes use a single word or `/{noun}/{verb}` pair so reserving
  the noun protects the whole subtree.
- **Built-in skills are source-traced contracts.** Code + `SKILL.md` +
  `references/*-source-map.md` move together in the same PR.
- **Dev builds stay unblocked by construction.** The CLI version gate's dev-describe
  escape hatch (plus the Makefile/bundle-cli synthesis when there are no tags) means
  `make build`/`make daemon` from a tagless fork passes the gate without weakening it
  for stale stable releases.

---

## 14. Where to look next

- `CLAUDE.md` — agent working conventions, the rules behind the decisions above.
- `AGENTS.md`, `CONTRIBUTING.md` — contribution flow.
- `CLI_AND_DAEMON.md`, `CLI_INSTALL.md`, `SELF_HOSTING*.md` — operator guides.
- `apps/docs/content/docs/developers/conventions.mdx` — naming/i18n/voice source of
  truth.
- `server/cmd/server/main.go` + `router.go` — the authoritative boot + wiring.
- `server/pkg/agent/agent.go` + `server/internal/daemon/daemon.go` — the agent
  execution model.
- `packages/core/platform/core-provider.tsx` + `packages/core/api/client.ts` — the
  frontend boot + API contract surface.
- `apps/desktop/src/main/index.ts` + `daemon-manager.ts` — the desktop app.