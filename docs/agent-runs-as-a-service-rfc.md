# RFC: Agent Runs as a Service

**Status:** Draft — design / RFC, not yet greenlit to build.
**Date:** 2026-06-24

## Context

Today agent runs are triggered only by in-app human actions — creating an issue,
assigning an agent, or commenting. The machinery behind those actions is already
a clean, centralized pipeline (a `TaskService`, a queue table, a daemon dispatch
loop, and a realtime event bus), but it is only reachable through the UI handlers.

The goal is to expose that same capability as a **service**: an upper-layer /
external client authenticates, asks an agent to run, and either polls for the
result, receives a webhook push when it finishes, or streams progress over
WebSocket — without going through the web UI.

Per the agreed scope, this document is a **design / RFC**, not a file-level
implementation plan. It defines the service surface, the request/response
contracts, and the security model — to review before committing to build.

It has two parts: **Part 1 — Current-State Analysis** (the verified pipeline
findings that ground the design) and **Part 2 — The RFC** (the proposed service
surface).

---

# Part 1 — Current-State Analysis

This records what the codebase does today, verified by reading the server. Every
section names the file/symbol so a future implementer can re-verify before
relying on it.

## 1.1 Triggers (implicit, in-band — there is no trigger enum / dispatcher)

There is no formal trigger registry. Triggers are inline conditionals in HTTP
handlers that call into `TaskService.Enqueue*`. The "triggers" are call-sites,
not a type.

**Assignment** (`server/internal/handler/issue.go`, `UpdateIssue` ~line 2530):
on `assigneeChanged` → `CancelTasksForIssue` + `shouldEnqueueAgentTask` →
`EnqueueTaskForIssue`; squad-assignee → `enqueueSquadLeaderTask`. Status change
out of `backlog` is a separate trigger (~line 2555). `shouldEnqueueAgentTask`
(issue.go:2663) is the central gate (backlog is a parking lot → skip; else
`isAgentAssigneeReady`: runtime_id set, not archived, private-agent access OK).
`CreateIssue`, `BatchUpdateIssues`, and the onboarding shim share this path.

**Comment / @mention** (`server/internal/handler/comment.go`):
- Local ad-hoc trigger taxonomy (NOT a system enum):
  ```go
  type commentAgentTriggerSource string
  const (
      commentTriggerSourceIssueAssignee      = "issue_assignee"
      commentTriggerSourceMentionAgent        = "mention_agent"
      commentTriggerSourceMentionSquadLeader  = "mention_squad_leader"
  )
  ```
- Pipeline: `computeCommentAgentTriggers` (comment.go:1155) →
  `filterSuppressedCommentAgentTriggers` (1097) →
  `enqueueCommentAgentTriggers` (1120) → `EnqueueTaskForIssue` /
  `EnqueueTaskForMention` / `EnqueueTaskForSquadLeader`.
- Dedup/coalescing: `HasPendingTaskForIssueAndAgent[ExcludingTriggerComment]`
  (comment.go:1228). A member reply in a member-started thread is suppressed
  (`isReplyToMemberThread`); mentions-of-others-but-not-assignee are suppressed.
  @mention has **no status gate** (fires even on done/cancelled issues).
- `PreviewCommentTriggers` (comment.go:836) at
  `POST /api/issues/{id}/comments/trigger-preview` previews which agents a
  comment will wake.

**Other triggers:**
- **Autopilot** (`server/internal/service/autopilot.go`): `dispatchCreateIssue`
  (145) creates issue then enqueues; `dispatchRunOnly` (284) inserts a task row
  directly with `AutopilotRunID` set. Triggered by the scheduler
  (`cmd/server/autopilot_scheduler.go`) or `POST /api/webhooks/autopilots/{token}`
  (`handler/autopilot_webhook.go`).
- **Chat** (`EnqueueChatTask`, task.go:709) — Lark / web chat.
- **Quick-create** (`EnqueueQuickCreateTask`, task.go:604) — NL prompt in
  `task.context` JSONB, no issue link.
- **Manual rerun** (`RerunIssue`, task.go:1604), `POST .../rerun`.
- **Auto-retry** (`MaybeRetryFailedTask`, task.go:1524) for infra-shaped failures
  (`runtime_offline`, `timeout`, …).

**The launch entry point** = enqueue (server-side) + dispatch (daemon pull).
`TaskService.enqueueIssueTask` / `enqueueMentionTask` (task.go:444 / :512) →
`Queries.CreateAgentTask` inserts `agent_task_queue` at `status='queued'`, then
the canonical sequence:
```go
s.broadcastTaskEvent(ctx, protocol.EventTaskQueued, task)  // WS notify (via Bus)
s.NotifyTaskEnqueued(ctx, task)                           // wake daemon
```

## 1.2 Run model — `agent_task_queue`

One row = one run. Fields (core): `id, agent_id, runtime_id, issue_id,
chat_session_id, autopilot_run_id, status, priority, dispatched_at, started_at,
completed_at, result (JSONB), error, failure_reason, trigger_comment_id,
trigger_summary, session_id, work_dir, attempt, max_attempts, parent_task_id,
force_fresh_session, is_leader_task, context (JSONB), initiator_user_id`.

**Status machine** (DB CHECK): `queued → dispatched → running → completed |
failed | cancelled`, plus `waiting_local_directory`. Autopilot *runs* can also be
`skipped` (runtime offline / admission gate) — that's `autopilot_run.status`, not
`agent_task_queue.status`. Transitions are SQL queries guarded by
`WHERE status = '…'`: `ClaimAgentTask` (queued→dispatched), `StartAgentTask`
(dispatched→running), `CompleteAgentTask` (running→completed), `FailAgentTask`
(running→failed), `CancelAgentTask*` (*→cancelled).

**Live output** = `task_message` rows (`ReportTaskMessages` →
`CreateTaskMessage`, daemon.go:2065), redacted via `redact.Text` /
`redact.InputMap`, each also broadcast as `protocol.EventTaskMessage`.
**Token usage** = `task_usage` (`UpsertTaskUsage`). Progress (summary/step/total)
is a transient WS event only (`TaskService.ReportProgress`, task.go:1809) — not
persisted.

**Final result** (`Handler.CompleteTask`, daemon.go:1878):
`result, _ := json.Marshal(req)` — the **entire `TaskCompleteRequest`** is
JSON-marshalled into `agent_task_queue.result`. Shape:
```json
{"pr_url":"…","output":"…","session_id":"…","work_dir":"…"}
```
(`TaskCompleteRequest`, daemon.go:1856). Parsed back downstream as
`protocol.TaskCompletedPayload{Output, PRURL}` (task.go:1270/1306) to synthesize
issue comments / save chat messages. Post-completion: `emitIssueExecutedOnFirstCompletion`
(analytics), `DeleteTaskTokensByTask` (revoke `mat_` task token), issue-comment
synthesis, quick-create inbox notify, chat:done broadcast, `ReconcileAgentStatus`,
`broadcastTaskEvent(EventTaskCompleted)`.

## 1.3 Dispatch transport — server ↔ daemon

The runtime is the `agent_runtime` table (`runtime_mode IN ('local','cloud')`);
each agent points at one via `agent.runtime_id`. **There is no server-side
"push to runtime" execution** — both local and cloud runtimes execute via a
daemon process that *pulls* tasks. A `cloud` runtime is a managed Multica Cloud
node running its own daemon with an `mcn_` cloud-node PAT. `runtime_mode` is
mostly a label for analytics/metrics (`taskMetricsContext`, task.go:274) and the
cloud-management proxy (`handler/cloud_runtime.go`), not a dispatch branch. The
per-CLI execution backends (codex/claude/copilot/cursor/pi/opencode) live in
`server/pkg/agent/` and are invoked by the *daemon*, not the server.

Daemon-facing HTTP endpoints mount under `/api/daemon/*`
(`server/cmd/server/router.go:481-513`), gated by `middleware.DaemonAuth`:

| Route | Handler | Purpose |
|---|---|---|
| `POST /runtimes/{id}/tasks/claim` | `ClaimTaskByRuntime` (daemon.go:1061) | Long-poll claim; returns `{task:nil}` when empty, else task + `TaskAgentData` (instructions, skills, custom_env/args, mcp_config, model, runtime_config, requesting user). Server: `TaskService.ClaimTaskForRuntime` (task.go:996) — reclaims stale dispatched, checks `EmptyClaim` cache, lists queued candidates, `ClaimTask` per agent until one belongs to this runtime. Mints an `mat_` task token at claim (daemon.go:1685) bound to (agent, task, workspace, owner). |
| `GET /runtimes/{id}/tasks/pending` | `ListPendingTasksByRuntime` | Pending count (backoff) |
| `GET /tasks/{id}/status` | `GetTaskStatus` (daemon.go:1994) | `{status}` mid-flight probe |
| `POST /tasks/{id}/start` | `StartTask` (daemon.go:1762) | dispatched→running; `broadcastTaskEvent(EventTaskRunning)` |
| `POST /tasks/{id}/wait-local-directory` | `MarkTaskWaitingLocalDirectory` | → `waiting_local_directory` |
| `POST /tasks/{id}/progress` | `ReportTaskProgress` (daemon.go:1829) | `{summary,step,total}` transient event |
| `POST /tasks/{id}/complete` | `CompleteTask` (daemon.go:1863) | stores `{pr_url,output,session_id,work_dir}` in `result` |
| `POST /tasks/{id}/fail` | `FailTask` (daemon.go:2014) | reason classified via `taskfailure.Classify` |
| `POST /tasks/{id}/usage` | `ReportTaskUsage` (daemon.go:1955) | `UpsertTaskUsage` |
| `POST/GET /tasks/{id}/messages` | `ReportTaskMessages` / `ListTaskMessages` | live output batched into `task_messages` |

Auth on every daemon task endpoint: `requireDaemonTaskAccess` /
`requireDaemonTaskAccessWithWorkspace` (daemon.go:109) verify the caller owns
the task's workspace.

**Wakeup path (immediate dispatch on enqueue):** `TaskWakeupNotifier`
(`NotifyTaskAvailable(runtimeID, taskID)`, task.go:46). `NotifyTaskEnqueued`
(task.go:1932) → `notifyTaskAvailable` (task.go:1944) bumps the `EmptyClaim`
cache invalidation version (before the wakeup, so an in-flight empty-claim
verdict is rejected) then calls `s.Wakeup.NotifyTaskAvailable`. Concrete
notifier: `daemonws.RelayNotifier` (`internal/daemonws/notifier.go:14`) +
`daemonws.Hub.NotifyTaskAvailable` (`internal/daemonws/hub.go:193`) — (a) local
`taskAvailableFrame` (`EventDaemonTaskAvailable` + `TaskAvailablePayload{RuntimeID,TaskID}`)
pushed to each connected daemon WS for that runtime with per-client ULID dedup;
(b) when Redis is configured, `relay.PublishWithID(ScopeDaemonRuntime, shardKey=taskID, …)`
so every API node can attempt local delivery (`RedisRelay`,
`internal/realtime/redis_relay.go:246` → `Hub.DeliverDaemonRuntime` :213). Daemon
side: WS reader feeds `taskWakeup` into a chan (buffered 256, daemon.go:668);
`pollLoop` (1879) fans to per-runtime pollers; `runRuntimePoller` (1972) breaks
its `sleepWithContextOrWakeup` and immediately `ClaimTask`s.

So the WS (`/api/daemon/ws`) is a **wakeup-only sideband**, not a task-body
channel. The task body moves over HTTP request/response.

## 1.4 Realtime / event bus

**`events.Bus`** (`server/internal/events/bus.go`): `Event{Type, WorkspaceID,
ActorType, ActorID, Payload, TaskID?, ChatSessionID?}`; `Subscribe(eventType,h)`,
`SubscribeAll(h)`, `Publish(e)` (synchronous, type-specific then global handlers,
each `recover()`-wrapped).

**`broadcastTaskEvent`** (`server/internal/service/task.go:1994`) publishes
**only to `events.Bus`** (NOT directly to `realtime.Hub`). Payload:
`{task_id, agent_id, issue_id, status, chat_session_id?}`. WorkspaceID resolved
by `ResolveTaskWorkspaceID` (task.go:2021: issue → chat session → autopilot run
→ quick-create context JSONB).

**Bus → WS bridge** = `registerListeners(bus, broadcaster)`
(`server/cmd/server/listeners.go:24`). Personal events → `SendToUser`; everything
else → a `SubscribeAll` handler (line 151) that marshals `{type, payload,
actor_id, actor_type}` and calls `b.BroadcastToWorkspace(e.WorkspaceID, data)`.
This is the single fanout point from Bus to WS. **Per-resource scope routing**
(`BroadcastToScope("task"|"chat", …)`) is **intentionally disabled** until
clients send subscribe frames (comment lines 169-183).

**Existing Bus subscribers** (clean insertion-point neighbors):
- `registerActivityListeners` (`activity_listeners.go:244`) — `task:completed`/`failed`.
- `registerAutopilotListeners` (`autopilot_listeners.go:47-53`) —
  `task:completed`/`failed`/`cancelled`.
- `registerNotificationListeners` (`notification_listeners.go:888`) — `task:failed`.

Task event types (`server/pkg/protocol/events.go:28-42`):
```
task:queued | task:dispatch | task:running | task:waiting_local_directory |
task:progress | task:completed | task:failed | task:message | task:cancelled
```
(plus `chat:done` at events.go:73). Events carry `{task_id, agent_id, issue_id,
status}`; the client re-fetches the task row for the terminal `result`.

## 1.5 Existing run fetch endpoints (user-facing `/api/*`)

In `server/internal/handler/agent.go` + `daemon.go`:
- `ListAgentTasks` — `GET /api/agents/{id}/tasks` (agent.go:1414) — full history;
  private-agent gated.
- `ListTasksByIssue` — `GET /api/issues/{id}/task-runs` (daemon.go:2247).
- `GetActiveTaskForIssue` — `GET /api/issues/{id}/active-task` (daemon.go:2196).
- `ListWorkspaceAgentTaskSnapshot` — `GET /api/agent-task-snapshot`
  (agent.go:1549) — active tasks + each agent's most recent OUTCOME task.
- `GetWorkspaceAgentRunCounts` / `GetWorkspaceAgentActivity30d`.
- `ListTaskMessagesByUser` — `GET /api/tasks/{taskId}/messages`
  (daemon.go:2272), optional `?since=<seq>` for catch-up.
- `CancelTask` (user) — `POST /api/tasks/{taskId}/cancel`; issue-scoped variant.

**Wire shape** = `AgentTaskResponse` (`server/internal/handler/agent.go:234`),
populated by `taskToResponse` (agent.go:380): `id, agent_id, runtime_id, issue_id,
workspace_id, status, priority, dispatched_at, started_at, completed_at, result,
error, failure_reason, attempt, max_attempts, parent_task_id, trigger_*,
work_dir, relative_work_dir, chat_session_id, autopilot_run_id, kind`.

**Gap:** there is **no single "fetch run result" endpoint** returning the terminal
`result` JSONB as a clean standalone resource — callers read it indirectly via
the list/snapshot/messages endpoints. This is the natural thing for channel 1
(poll) to provide.

## 1.6 Auth / token taxonomy

Two middlewares (`server/internal/middleware/`):
- **`Auth`** (auth.go:37) — `/api/*` user routes. Token sources: `Authorization:
  Bearer <token>` header, or `multica_auth` HttpOnly cookie (JWT, CSRF-gated for
  state-changing). Sets `X-User-ID`. Workspace via `X-Workspace-ID` /
  `X-Workspace-Slug` header (allowed list router.go:404), resolved by
  `handler.resolveWorkspaceID`.
- **`DaemonAuth`** (daemon_auth.go:79) — `/api/daemon/*`. Same extraction,
  recognizes daemon-specific prefixes.

**Four token kinds** (by prefix):
| Prefix | Kind | Purpose |
|---|---|---|
| `mul_` | PAT | Programmatic user access (CLI, daemon fallback, **external clients**) |
| `mdt_` | Daemon token | Per-daemon workspace-scoped machine credential |
| `mcn_` | Cloud Node PAT | Multica Cloud Fleet node identity (verified via `CloudPATVerifier`) |
| `mat_` | Agent task token | Per-task, minted at claim (daemon.go:1685), 24h, bound to (user,agent,task,workspace) |

PAT is user-managed (`router.go:629-633`): `POST /api/tokens` (mint, default
90-day expiry), `GET /api/tokens` (list), `POST /api/tokens/current/renew`
(in-place renewal inside 7-day window), `DELETE /api/tokens/{id}` (revoke).
PAT lookups cached (`auth.PATCache`, short TTL), shared between `Auth` and
`DaemonAuth`.

**Realtime `/ws` accepts `mul_` PATs.** `HandleWebSocket` (hub.go:746) first
tries the `multica_auth` cookie; if absent, upgrades the WS and reads the first
message as an auth frame, handled by `authenticateToken` (hub.go:669):
```go
if strings.HasPrefix(tokenStr, "mul_") {
    uid, ok := pr.ResolveToken(ctx, tokenStr)   // PATResolver → shared PAT cache
    ...
}
```
Membership still enforced via `MembershipChecker.IsMember` (hub.go:770/794)
regardless of token kind. `/ws` does NOT accept `mdt_`/`mcn_`/`mat_` — those are
daemon-scoped and only valid on `/api/daemon/*` + the daemon WS. The daemon WS
(`GET /api/daemon/ws`) is a separate hub (`daemonws.Hub`).

## 1.7 Webhook delivery infra (inbound only — no outbound worker)

`webhook_delivery.go` + `autopilot_webhook.go` implement **receiving** external
provider webhooks (GitHub/GitLab/generic) that *trigger* autopilot runs. The
`webhook_delivery` table records **inbound** deliveries. **There is no outbound
HTTP delivery worker anywhere** (confirmed by search across
`server/internal/service` + `handler` — only OAuth token exchange, Lark, Stripe,
GitHub inbound).

Reusable as **patterns** (not a worker):
- `HandleAutopilotWebhook` (autopilot_webhook.go:343): per-IP + per-token rate
  limit → token lookup → body cap → normalize → dedupe + signature verify →
  persist `webhook_delivery` (status `queued`) → `DispatchAutopilot` →
  `finaliseDeliveryWithRun` / `finaliseDeliveryTerminal`.
- Status enum (autopilot_webhook.go:71-75): `queued/dispatched/rejected/ignored/failed`.
  Signature-status enum (55-58): `not_required/valid/invalid/missing`.
- Dedupe (`webhook_delivery.sql.go`): `GetWebhookDeliveryByTriggerAndDedupe`
  (line 191) keyed on `(trigger_id, dedupe_key)` with a partial-unique index
  excluding non-successful terminal statuses; on collision (23505) bump
  `attempt_count`, return original `delivery_id` + `autopilot_run_id`.
  `CreateWebhookDelivery` (92), `UpdateWebhookDeliveryDispatched` (381),
  `UpdateWebhookDeliveryTerminal` (439), `BumpWebhookDeliveryAttempt` (25).
- **Signing — verify only**: `verifyWebhookSignatureForProvider`
  (autopilot_webhook.go:244) + `verifyHubSignature` (262) — GitHub-compatible
  `X-Hub-Signature-256: sha256=<hex(hmac-sha256(body, secret))>` with
  `hmac.Equal` constant-time. **No outbound signer exists** — this verify helper
  is the reference scheme for the one channel 2 must add.

## 1.8 Key file/symbol index

- Task service: `server/internal/service/task.go` — `TaskService:27`,
  `TaskWakeupNotifier:46`, `NewTaskService:108`, `EnqueueTaskForIssue:431`,
  `EnqueueTaskForMention:498`, `EnqueueTaskForSquadLeader:508`,
  `EnqueueQuickCreateTask:604`, `EnqueueChatTask:709`, `ClaimTaskForRuntime:996`,
  `StartTask:1126`, `CompleteTask:1177`, `FailTask:1360`, `ReportProgress:1809`,
  `NotifyTaskEnqueued:1932`, `notifyTaskAvailable:1944`, `broadcastTaskEvent:1994`,
  `ResolveTaskWorkspaceID:2021`.
- Daemon handlers: `server/internal/handler/daemon.go` — `DaemonRegister:253`,
  `DaemonHeartbeat:651`, `ClaimTaskByRuntime:1061`, `StartTask:1762`,
  `ReportTaskProgress:1829`, `CompleteTask:1863`, `GetTaskStatus:1994`,
  `FailTask:2014`, `ReportTaskUsage:1955`, `ReportTaskMessages:2065`,
  `ListTaskMessages:2153`; WS `daemon_ws.go:11`.
- Daemon supervisor/client: `server/internal/daemon/daemon.go` (`Run:601`,
  `pollLoop:1879`, `runRuntimePoller:1972`), `server/internal/daemon/client.go`
  (`Client:90`, `Register:442`, `ClaimTask:156`, `postJSON:562`).
- Wakeup: `server/internal/daemonws/notifier.go:14` (`RelayNotifier`),
  `hub.go:193` (`Hub.NotifyTaskAvailable`), `:270` (`taskAvailableFrame`),
  `:213` (`DeliverDaemonRuntime`); `server/internal/realtime/redis_relay.go`
  (`RedisRelay:131`, `BroadcastToScope:246`).
- Event bus: `server/internal/events/bus.go` (`Event:9`, `Bus:28`, `Subscribe:43`,
  `SubscribeAll:51`, `Publish:61`); bridge `server/cmd/server/listeners.go:24`
  (`SubscribeAll` at :151); subscribers `activity_listeners.go:244`,
  `autopilot_listeners.go:47`, `notification_listeners.go:888`.
- Webhook (inbound): `server/internal/handler/autopilot_webhook.go`
  (`HandleAutopilotWebhook:343`, `verifyHubSignature:262`, enums :55-75),
  `webhook_delivery.go`, `server/pkg/db/generated/webhook_delivery.sql.go`.
- Wire shape: `AgentTaskResponse` (`agent.go:234`), `taskToResponse` (:380).
- PAT: `server/internal/handler/personal_access_token.go`; routes `router.go:629-633`.
- Realtime: `server/internal/realtime/hub.go` (`HandleWebSocket:746`,
  `authenticateToken:669`, `PATResolver:31`, `MembershipChecker:24`).
- Routes: `server/cmd/server/router.go` — daemon :481-513, autopilot webhook :469,
  user `/api/*` group :517+.
- Sweeper worker (sibling for a new outbound worker): `server/cmd/server/runtime_sweeper.go`.

## 1.9 Summary of the current pipeline

1. **Trigger** (implicit, in-band): issue assign/status (`handler/issue.go`),
   comment/@mention (`handler/comment.go`), autopilot (`service/autopilot.go`),
   chat, quick-create, manual rerun, auto-retry.
2. **Enqueue** (the launch): `TaskService.Enqueue*` → `Queries.CreateAgentTask`
   inserts `agent_task_queue` at `queued` → `broadcastTaskEvent(task:queued)` +
   `NotifyTaskEnqueued` (wakes daemon).
3. **Dispatch** (pull): daemon claims via `POST /api/daemon/runtimes/{id}/tasks/claim`
   (`queued→dispatched`), or is woken early by the `daemon:task_available` WS frame
   from `RelayNotifier`. Then `StartTask` (`→running`), streams `task:message`,
   then `CompleteTask`/`FailTask` (terminal). `mat_` task token minted at claim.
4. **State**: `agent_task_queue` (status/timestamps/result/error/failure_reason/
   session_id/work_dir) + `task_message` (live output). Queries in
   `pkg/db/queries/agent.sql`.
5. **Notify**: every transition publishes `task:*` on `events.Bus` → bridge
   listener → `realtime.Hub` → workspace-scoped WS clients. No dedicated result
   payload; clients re-fetch via list/snapshot/messages endpoints.
6. **Auth**: user `/api/*` via `mul_` PAT or JWT (cookie/bearer) + `X-Workspace-ID`;
   daemon `/api/daemon/*` via `mdt_`/`mcn_`/`mul_`/JWT; agent process via `mat_`;
   user `/ws` via cookie or first-frame `mul_`/JWT (membership-enforced).

**Gaps relevant to the service**: no "trigger by agent+prompt" external API
(enqueue is buried in issue/comment handlers and gated on assignee semantics);
no trigger enum/dispatcher; no dedicated "fetch run result" endpoint; no outbound
webhook worker. The `mul_` PAT + `/ws` PAT support + `events.Bus` subscribe
points are the ready primitives to build on.

---

# Part 2 — The RFC

## What already exists (the foundation — reuse, don't rebuild)

Everything below is live code today. The service is largely a **new REST/WS
surface on top of existing internals**.

- **Trigger layer** — `server/internal/service/task.go` (`TaskService`)
  centralizes every enqueue path:
  - `EnqueueTaskForIssue` (assignment / comment on an agent-assigned issue)
  - `EnqueueTaskForMention` / `EnqueueTaskForSquadLeader` (@mention / squad leader)
  - `EnqueueQuickCreateTask` (ad-hoc prompt stored in `task.context`; agent runs
    `multica issue create`)
  - `EnqueueChatTask` (chat-session runs)
  Every path validates the agent (not archived, has a runtime), inserts an
  `agent_task_queue` row at status `queued`, broadcasts a `task:queued` event,
  and calls `NotifyTaskEnqueued` to wake the daemon.
- **Run model** — one `agent_task_queue` row = one run. Status machine:
  `queued → dispatched → running → completed | failed | cancelled` (plus
  `waiting_local_directory`). Terminal result lives in `result` (JSONB),
  failure text in `error`, coarse classifier in `failure_reason`, progress
  messages in `task_messages`, token usage in `task_usage`.
- **Dispatch** — daemon (a PAT-authenticated external client itself) connects via
  `/api/daemon/ws`, claims via `POST /api/daemon/runtimes/{id}/tasks/claim`,
  acks with `/tasks/{id}/start`, streams `/progress` + `/messages`, terminates
  with `/complete` or `/fail`. `TaskWakeupNotifier.NotifyTaskAvailable` pokes the
  daemon WS for immediate claim.
- **Realtime** — `broadcastTaskEvent` (`server/internal/service/task.go:1994`)
  publishes `task:queued | dispatch | running | waiting_local_directory |
  progress | completed | failed | message | cancelled`
  (`server/pkg/protocol/events.go`) **to `events.Bus` only**. A bridge listener
  (`server/cmd/server/listeners.go:151`, a `Bus.SubscribeAll` handler) fans Bus
  events out to `realtime.Hub` workspace-scoped WS clients via
  `BroadcastToWorkspace`. The Hub authorizes each WS connection to a workspace
  scope and/or user scope. So the WS stream already carries every `task:*`
  event for a workspace; a new outbound listener is a clean insertion next to
  `autopilot_listeners.go` / `activity_listeners.go`.
- **Run wire shape** — `AgentTaskResponse` (`server/internal/handler/agent.go:380`)
  is the existing JSON shape for a run: `id, agent_id, runtime_id, issue_id,
  workspace_id, status, priority, dispatched_at, started_at, completed_at,
  result, error, failure_reason, attempt, trigger_*, work_dir, kind`. This is
  the natural "run" contract — reuse it verbatim.
- **Auth** — Personal Access Tokens (`mul_`, `server/internal/handler/
  personal_access_token.go`) authenticate through the standard Auth middleware;
  the daemon is itself a PAT-authenticated external client. A PAT resolves to a
  user, and workspace membership gates every workspace-scoped call. Managed
  endpoints exist: `POST /api/tokens` (mint), `GET /api/tokens` (list),
  `POST /api/tokens/current/renew` (renew), `DELETE /api/tokens/{id}` (revoke).
  Other token kinds are out of scope for external clients: `mdt_` (daemon),
  `mcn_` (cloud node), `mat_` (per-task agent token minted at claim).
- **Webhook delivery pattern** — `server/internal/handler/webhook_delivery.go`
  + `autopilot_webhook.go` is **inbound only** (receives GitHub/GitLab/generic
  webhooks that trigger autopilot runs). There is **no outbound HTTP delivery
  worker** today. But the inbound model — `webhook_delivery` table with status
  enum (`queued/dispatched/rejected/ignored/failed`), `attempt_count`,
  `(trigger_id, dedupe_key)` partial-unique dedupe, signature-status enum, and
  the HMAC-SHA256 `sha256=<hex>` scheme in `verifyHubSignature`
  (`autopilot_webhook.go:262`) — is the **template** to model an outbound
  delivery worker + outbound signer + outbound delivery table on.

## Proposed service surface

### Auth (no new auth code)

External clients mint a PAT in the UI (`POST /api/me/...` PAT endpoints exist)
and send `Authorization: Bearer mul_…`. The standard Auth middleware resolves it
to a user; workspace membership + `X-Workspace-ID` gate every call, exactly as
for the web client. No service-account / API-key concept in this RFC.

**Permission model (reuse existing):** a client may trigger a run on an agent
iff the PAT's user can *see* that agent in the workspace (agent visibility +
workspace membership, same checks the UI uses). Triggering does not grant the
client any new privilege — the agent runs with its own runtime and CLI identity,
not the caller's.

### Trigger channel A — Direct run endpoint (new)

`POST /api/workspaces/{workspaceId}/runs` (or `…/agents/{agentId}/runs`).

A "direct run" is an ad-hoc, result-returning execution that is **not** tied to
an issue. It reuses the quick-create task plumbing (`EnqueueQuickCreateTask`-
style: prompt in `task.context`, agent executes via the daemon) but with a new
task-context type that instructs the agent to **return output directly** instead
of creating an issue.

Request (RFC shape):
```json
{
  "agent_id": "<uuid>",            // required; agent must be in this workspace, not archived, has runtime
  "prompt": "<natural-language instructions>",   // required
  "context": { /* optional structured context: repo, files, params */ },
  "attachment_ids": ["<uuid>"],    // optional, reuse existing attachment upload
  "priority": "high|medium|low",   // optional
  "result_callback": {             // optional — enables webhook push for THIS run
    "url": "https://client.example/runs/callback",
    "secret": "<shared secret for HMAC>"   // or a pre-registered workspace-level endpoint
  },
  "idempotency_key": "<client-supplied>"   // optional; dedupe concurrent retries
}
```

Response `202 Accepted`:
```json
{ "run_id": "<uuid>", "status": "queued", "agent_id": "<uuid>", "workspace_id": "<uuid>" }
```

Server-side: new `TaskService.EnqueueDirectRun` (mirrors `EnqueueQuickCreateTask`
but with a `direct_run` context type and no `multica issue create` instruction).
The daemon claim handler gets one more context-type branch that briefs the agent
to write its final output to the task result instead of creating an issue. The
agent's existing completion path (`CompleteTask`) already stores arbitrary JSON
in `result`, so no storage change is needed.

> **Open question for review:** should a "direct run" still allow the agent to
> use the full multica CLI (read issues, comment, etc.), or be sandboxed to
> pure text output? Default proposal: full CLI — the agent is the same trusted
> actor as in issue flows; "direct" only changes *what the agent is asked to
> produce*, not its capabilities.

### Trigger channel B — Reuse the issue flow (documented, no new code)

External clients can already trigger runs through the existing REST endpoints:
`POST /api/.../issues` (create + assign to an agent), `POST /api/.../issues/{id}/comments`
(@mention or assignee-comment triggers), `POST /api/.../issues/{id}/rerun`. This
requires zero new code; the RFC just **documents** it as a supported service
entry point and notes its semantics differ from a direct run (every run is bound
to an issue; results land as issue comments; trigger rules — assignee/mention/
squad — apply).

### Result delivery channel 1 — Poll REST (new, thin)

- `GET /api/workspaces/{workspaceId}/runs/{runId}` → the existing
  `AgentTaskResponse` shape (status, result, error, timestamps, kind). Backed by
  a workspace-scoped `GetAgentTaskInWorkspace`-style lookup (membership-gated).
- `GET /api/workspaces/{workspaceId}/runs` → list with filters (`agent_id`,
  `status`, `since`) — workspace-scoped, reusing the snapshot/list queries.
- `GET /api/workspaces/{workspaceId}/runs/{runId}/messages` → progress messages
  (reuse `ListTaskMessages`, expose to non-daemon callers).

Polling contract: a run is terminal when `status ∈ {completed, failed,
cancelled}`. `result` is populated on `completed`; `error` + `failure_reason` on
`failed`. Document a recommended poll interval (e.g. 2–5s) and that WS/webhook
are preferred for long runs.

### Result delivery channel 2 — Webhook push on completion (new — must build the worker)

Server → client `POST` to the registered callback URL when a run reaches a
terminal status. **There is no outbound delivery worker today**, so this channel
builds one, modeled on the inbound `webhook_delivery` table and the
`verifyHubSignature` scheme (`server/internal/handler/autopilot_webhook.go:262`):

- **Outbound delivery table** (new, modeled on `webhook_delivery`): `queued |
  dispatched | failed | ignored` status enum, `attempt_count`,
  `last_attempt_at`, `response_status`, `response_body`, `error`, and a
  `(subscription_id, dedupe_key)` partial-unique index for idempotent redelivery.
- **Outbound HMAC signer** (new): the inverse of `verifyHubSignature` —
  `sha256=<hex(hmac-sha256(rawBody, secret))>` over the raw body, plus an
  `X-Multica-Timestamp` for replay-window checking. The verify helper is the
  reference for the scheme.
- **Outbound worker** (new, alongside `runRuntimeSweeper` in
  `server/cmd/server/runtime_sweeper.go`): drains `queued` rows, POSTs with
  backoff/retries, records `response_status`/`response_body`, marks terminal.

Two registration modes (RFC picks one to start, both feasible):
- **Per-run** — `result_callback` in the trigger request (channel A only). Simple,
  no stored config; the secret travels in the trigger call. The outbound
  delivery row keys off the run's `task_id`.
- **Per-workspace endpoint** — a registered webhook target + secret in workspace
  settings; all runs (including issue-flow runs) push there. More like the
  autopilot webhook model; requires a small settings table.

Payload (RFC shape):
```json
{
  "event": "run.completed",          // run.completed | run.failed | run.cancelled
  "run_id": "<uuid>",
  "workspace_id": "<uuid>",
  "agent_id": "<uuid>",
  "issue_id": "<uuid|null>",
  "status": "completed",
  "result": { /* the agent's {pr_url, output, session_id, work_dir} JSON */ },
  "error": null,
  "failure_reason": null,
  "started_at": "...", "completed_at": "...",
  "attempt": 1
}
```
Signed with `X-Multica-Signature: sha256=<hex>` and `X-Multica-Timestamp`.

**Wiring (clean insertion point):** `TaskService.CompleteTask` / `FailTask` /
cancel paths already publish `protocol.EventTaskCompleted | EventTaskFailed |
EventTaskCancelled` on `events.Bus` (`broadcastTaskEvent`). A new
`events.Bus.Subscribe` listener (next to `autopilot_listeners.go` /
`notification_listeners.go`) consumes those events, fetches the run's `result`
via `GetAgentTask`, and enqueues an outbound delivery for any run that has a
callback registered. So push is a *subscriber on the existing bus*, not a fork
of the completion code — identical to how `autopilot_listeners` already reacts
to `EventTaskCompleted`.

### Result delivery channel 3 — WebSocket event stream (already works)

The `realtime.Hub` already broadcasts `task:*` events to workspace-scoped WS
subscribers, and **`/ws` already accepts `mul_` PATs** — confirmed by
`authenticateToken` (`server/internal/realtime/hub.go:669`), which resolves
`mul_`-prefixed tokens via the shared `PATResolver` and enforces membership
via `MembershipChecker.IsMember`. A non-browser client authenticates by
sending `{"type":"auth","payload":{"token":"mul_…"}}` as the first WS frame.

So an external client connects to `GET /ws` (workspace-resolved via
`X-Workspace-Slug`), sends the PAT auth frame, and receives the full
`task:queued | dispatch | running | waiting_local_directory | progress |
message | completed | failed | cancelled` stream for that workspace — **no new
server code for the stream itself**. Events carry `{task_id, agent_id, issue_id,
status}`; the client re-fetches `GET /runs/{id}` for the terminal `result`.

Optional refinement (not required for v1): per-resource WS scope routing
(`BroadcastToScope("task"|"chat", …)`) is **intentionally disabled** today
until clients send subscribe frames (`server/cmd/server/listeners.go:169–183`).
A **run-scoped** subscription would require enabling that path: clients send a
`subscribe { "scope": "run", "id": "<runId>" }` frame and the Hub's
`AuthorizeScope` gains a `run` scope type (workspace membership + run ownership).
Nice for a client that only wants one run's events, but workspace-scoped
filtering client-side is sufficient for v1.

## Security model

- **Authn:** PAT only. No unauthenticated trigger/fetch endpoints.
- **Authz:** every endpoint is workspace-scoped + membership-gated, identical to
  the web client. Agent visibility (workspace vs private) gates which agents a
  client may target. A client cannot trigger an agent it couldn't see in the UI.
- **No privilege escalation:** triggering a run does not run code *as the
  caller*. The agent executes with its own runtime/CLI identity, as today. The
  caller only schedules work and reads results.
- **Webhook egress safety:** outbound callbacks are opt-in, target a URL the
  client supplied, HMAC-signed, replay-protected, and rate-limited. The server
  must not POST run `result` payloads that contain data the caller couldn't
  already read (workspace membership is the boundary — same as poll).
- **Result contents:** `result` is whatever the agent wrote. Treat it as
  untrusted agent output (it already is, in the UI). Document that the client
  should parse defensively, consistent with the project's API Response
  Compatibility rules.
- **Rate limiting:** trigger and poll endpoints sit behind the existing
  per-IP/per-user rate limiters (`middleware.RateLimit`). Webhook egress gets
  its own outbound concurrency/retry caps.

## New vs reused (summary)

| Area | New code | Reused |
|---|---|---|
| Auth | none | PAT + Auth middleware + membership |
| Trigger A (direct run) | `EnqueueDirectRun` service method; `direct_run` context type + daemon claim branch; `POST /runs` handler + route | `CreateAgentTask`, daemon dispatch loop, `NotifyTaskEnqueued`, `broadcastTaskEvent` |
| Trigger B (issue flow) | docs only | existing issue/comment/rerun endpoints |
| Poll REST | `GET /runs`, `GET /runs/{id}`, `GET /runs/{id}/messages` handlers + routes; workspace-scoped lookup query | `AgentTaskResponse`, `ListTaskMessages`, snapshot queries |
| Webhook push | outbound delivery subscriber on `events.Bus`; **new** outbound delivery table + outbound HMAC signer + outbound worker | inbound `webhook_delivery` table + `verifyHubSignature` scheme as template; `events.Bus` subscribe point |
| WS stream | none for v1 (PAT auth on `/ws` already works); optional `run` scope later | `realtime.Hub`, `/ws` PAT first-frame auth, `task:*` events via Bus→Hub bridge |

## Suggested build sequence (when greenlit)

1. Poll REST surface + `EnqueueDirectRun` + `POST /runs` (minimum viable service:
   trigger + poll). Tests: malformed-response / missing-field per API
   Compatibility rules.
2. WS stream: verify PAT auth on `/ws`; add `run` scope if desired.
3. Webhook push: per-run callback first, then optional per-workspace endpoint.
4. Issue-flow documentation.

## Verification (end-to-end, when implemented)

- `make check` (typecheck + TS/Go unit tests + E2E).
- Go handler tests: PAT-authed trigger, cross-workspace 404, membership denial,
  archived/no-runtime agent rejection, webhook signature + replay window,
  malformed `result` handling.
- E2E (`e2e/`): with a local daemon runtime running — PAT client triggers a
  direct run, polls to terminal, asserts `result`; registers a webhook callback
  (a test request bin), asserts a signed `run.completed` delivery arrives.
- Manual: connect a PAT WS client to `/ws`, trigger a run, observe the
  `task:*` stream.

## Open questions for review

1. **Direct-run agent scope** — full CLI capabilities, or text-output-only
   sandbox? (Default proposal: full CLI — the agent is the same trusted actor
   as in issue flows.)
2. **Webhook registration** — start with per-run `result_callback`, per-workspace
   endpoint, or both? (Default proposal: per-run first; the outbound worker is
   the same either way.)
3. **Run-scoped WS subscription** — worth enabling the per-resource scope path
   (`BroadcastToScope("run", …)`) now, or is workspace-scoped streaming +
   client-side filtering enough for v1? (Default: workspace-scoped for v1.)
4. **Naming** — expose as `/runs` (this RFC) or align with the existing
   `agent_task_queue` / "task" vocabulary the UI uses (`/tasks`)? `runs` reads
   cleaner to external clients but diverges from internal naming; the wire
   shape is `AgentTaskResponse` either way.
---

# Part 3 — POC Implementation Status (2026-06-25)

A POC of this service was built behind the `MULTICA_ENABLE_POC_RUNS_API` env
gate (off by default; never enable in production/staging). Auth is deliberately
removed for the POC — workspace scoping is the only boundary, and the env gate
is the compensation. All three delivery channels are now wired.

## Trigger (channels A + B)

- `POST /api/poc/runs` (`server/internal/handler/poc_runs.go::PocTriggerRun`)
  — body `{workspace_id, agent_id, prompt, mode?, result_callback?}`. Returns
  `202 {run_id, status, agent_id, workspace_id}`.
  - `mode: "quick_create"` (default) reuses `TaskService.EnqueueQuickCreateTask`
    (the agent runs `multica issue create`). Zero requester —
    `notifyQuickCreateCompleted` bails safely on empty `RequesterID`.
  - `mode: "direct"` calls the new `TaskService.EnqueueDirectRun`
    (`server/internal/service/task.go`), which stores a `direct_run` task
    context. The daemon claim handler
    (`server/internal/handler/daemon.go`) surfaces `resp.DirectRunPrompt`, and
    `buildDirectRunPrompt` (`server/internal/daemon/prompt.go`) briefs the agent
    to execute and return output directly (no issue created). The agent's
    terminal output lands in `agent_task_queue.result` via the existing
    completion path — no storage change.
- `GET /api/poc/runs/{runId}` — workspace-scoped `AgentTaskResponse` (status,
  result, error, timestamps, kind).
- `GET /api/poc/runs/{runId}/messages` — progress messages (`?since=<seq>`).
- Routes mounted in `server/cmd/server/router.go` only when
  `MULTICA_ENABLE_POC_RUNS_API=1`.

## Result delivery

- **Channel 1 — Poll REST:** the `GET` endpoints above.
- **Channel 2 — Webhook push:** `result_callback: {url, secret}` on the
  trigger persists a `poc_run_callback` row (migration 121). A Bus subscriber
  (`server/cmd/server/run_callback_listeners.go`) fires on `task:completed` /
  `failed` / `cancelled`, POSTs a signed payload (`X-Multica-Signature:
  sha256=<hex(hmac-sha256(body, secret))>`, the inverse of the inbound
  `verifyHubSignature` scheme), and records delivery. For the POC delivery is
  INLINE in the subscriber; a queued-row worker with backoff/retry is the
  production follow-up.
- **Channel 3 — WebSocket stream:** `/ws` already accepts `mul_` PATs
  (`realtime.authenticateToken`); a client sends
  `{"type":"auth","payload":{"token":"mul_…"}}` as the first frame and receives
  workspace-scoped `task:*` events, filtering by `run_id` client-side. The
  per-resource `BroadcastToScope("run", …)` refinement is deliberately NOT
  enabled — flipping it would break the existing web/desktop client, which
  doesn't send subscribe frames yet (see `listeners.go:169`, MUL-1138).

## Tests

- `server/internal/handler/poc_runs_test.go` — trigger happy path, validation,
  direct-mode context type, foreign-workspace 404, callback registration.
- `server/internal/daemon/prompt_test.go` — direct-run prompt rules + dispatch.
- `server/internal/realtime/hub_test.go` — mul_ PAT auth/reject on `/ws`.
- `server/cmd/server/run_callback_listeners_test.go` — signer round-trip,
  payload builder, end-to-end signed delivery to a test HTTP target.

## Deliberately out of POC scope

- Auth / membership (the whole point of the POC; the env gate compensates).
- Outbound retry worker (inline delivery in the subscriber for now).
- Per-workspace webhook endpoint registration (per-run `result_callback` only).
- Run-scoped WS subscription (workspace-scoped + client filtering for v1).
