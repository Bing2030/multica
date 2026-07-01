package handler

// poc_runs.go is a PROOF-OF-CONCEPT "agent runs as a service" API.
//
// SECURITY: these handlers are deliberately unauthenticated. They are mounted
// only when MULTICA_ENABLE_POC_RUNS_API=1 (see server/cmd/server/router.go),
// which is OFF BY DEFAULT and must never be enabled in production or staging.
// The env gate is the only thing standing between an open trigger endpoint and
// the public internet — do not mount these routes unconditionally.
//
// The POC reuses the existing quick-create task plumbing
// (TaskService.EnqueueQuickCreateTask) so a run can be triggered and polled
// with zero daemon-side changes: the daemon claim handler already recognizes
// the quick_create task context and briefs the agent to run
// `multica issue create`. A future "direct run" (agent returns output without
// creating an issue) is out of scope for this POC — see
// docs/agent-runs-as-a-service-rfc.md.
//
// Because auth is removed, workspace scoping is the only boundary: every call
// resolves a workspace_id and scopes the task lookup to it (GetAgentTaskInWorkspace),
// so a caller can only read runs in the workspace they name. There is no
// membership check — that is the deliberate POC simplification and the reason
// the routes must stay env-gated.

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// PocTriggerRunRequest is the body for POST /api/poc/runs.
type PocTriggerRunRequest struct {
	WorkspaceID string `json:"workspace_id"` // required; falls back to X-Workspace-ID header
	AgentID     string `json:"agent_id"`     // required
	Prompt      string `json:"prompt"`       // required
	// Mode selects the run kind. "quick_create" (default) asks the agent to
	// run `multica issue create` from the prompt; "direct" asks the agent to
	// execute the prompt and return its output directly (no issue created).
	// See docs/agent-runs-as-a-service-rfc.md (channels A/B).
	Mode string `json:"mode"`
	// ResultCallback optionally registers an outbound webhook for THIS run
	// (RFC channel 2). When set, the server POSTs a signed payload to URL on
	// run completion/failed/cancelled. Secret signs the body with
	// X-Multica-Signature (sha256=<hex(hmac)>); the client verifies
	// constant-time.
	ResultCallback *PocResultCallback `json:"result_callback,omitempty"`
}

// PocResultCallback is a per-run outbound webhook target.
type PocResultCallback struct {
	URL    string `json:"url"`    // required; https URL the server POSTs the signed payload to
	Secret string `json:"secret"` // required; HMAC-SHA256 shared secret used to sign the body
}

// PocTriggerRunResponse is the 202 Accepted body for POST /api/poc/runs.
type PocTriggerRunResponse struct {
	RunID       string `json:"run_id"`
	Status      string `json:"status"`
	AgentID     string `json:"agent_id"`
	WorkspaceID string `json:"workspace_id"`
}

// PocTriggerRun enqueues a quick-create task for the named agent and returns
// the run id immediately. The run executes asynchronously on the agent's
// runtime exactly like an in-app quick-create.
func (h *Handler) PocTriggerRun(w http.ResponseWriter, r *http.Request) {
	var req PocTriggerRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		writeError(w, http.StatusBadRequest, "prompt is required")
		return
	}

	// Resolve the workspace: prefer the body, fall back to the X-Workspace-ID
	// header (so the handler works with the standard request helpers that set
	// the header). No auth means no middleware-injected context — the caller
	// names the workspace explicitly.
	workspaceID := strings.TrimSpace(req.WorkspaceID)
	if workspaceID == "" {
		workspaceID = h.resolveWorkspaceID(r)
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}

	agentUUID, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(req.AgentID), "agent_id")
	if !ok {
		return
	}

	// Reuse the same workspace / archived / runtime-online gates as the
	// authenticated quick-create path so the POC can't dispatch an archived
	// agent or one whose runtime is offline. We deliberately skip
	// validateAssigneePair's private-agent ownership check — that is a
	// membership concern and the POC has no membership. The env gate is the
	// compensation.
	agent, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{
		ID:          agentUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "agent not found in this workspace")
		return
	}
	if agent.ArchivedAt.Valid {
		writeError(w, http.StatusBadRequest, "agent is archived")
		return
	}
	if !agent.RuntimeID.Valid {
		writeAgentUnavailable(w, "agent has no runtime")
		return
	}
	if !h.isRuntimeOnline(r.Context(), agent.RuntimeID) {
		writeAgentUnavailable(w, "agent's runtime is offline")
		return
	}

	// Mode selects the run kind. Default is quick_create (back-compat with
	// the first POC cut): the agent runs `multica issue create` from the
	// prompt. "direct" asks the agent to execute and return output directly.
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	var task db.AgentTaskQueue
	switch mode {
	case "", "quick_create", "quick":
		// Zero requester: the POC has no user. notifyQuickCreateCompleted
		// bails safely when RequesterID is empty (it logs and returns), so a
		// run with no requester won't crash the completion path.
		task, err = h.TaskService.EnqueueQuickCreateTask(
			r.Context(),
			wsUUID,
			pgtype.UUID{}, // no requester — POC is unauthenticated
			agentUUID,
			pgtype.UUID{}, // no squad
			prompt,
			pgtype.UUID{}, // no project
			pgtype.UUID{}, // no parent issue
			nil,           // no attachments
		)
	case "direct", "direct_run":
		task, err = h.TaskService.EnqueueDirectRun(r.Context(), wsUUID, agentUUID, prompt)
	default:
		writeError(w, http.StatusBadRequest, "invalid mode; valid values: quick_create, direct")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to enqueue run")
		return
	}

	// Optional per-run outbound webhook (RFC channel 2). Register before
	// responding so the callback is in place by the time the run could
	// complete. A failure to register the callback does NOT fail the trigger
	// — the run still queued; only push delivery is lost. Best-effort, logged.
	if req.ResultCallback != nil {
		registerPocRunCallback(r.Context(), h, task.ID, wsUUID, req.ResultCallback)
	}

	writeJSON(w, http.StatusAccepted, PocTriggerRunResponse{
		RunID:       uuidToString(task.ID),
		Status:      task.Status,
		AgentID:     uuidToString(agentUUID),
		WorkspaceID: uuidToString(wsUUID),
	})
}

// registerPocRunCallback validates the callback target and persists it so the
// run-callback Bus subscriber can deliver on completion. Best-effort: errors
// are logged, not returned, because a missing callback must not fail an
// already-queued run.
func registerPocRunCallback(ctx context.Context, h *Handler, taskID, workspaceID pgtype.UUID, cb *PocResultCallback) {
	url := strings.TrimSpace(cb.URL)
	secret := strings.TrimSpace(cb.Secret)
	if url == "" || secret == "" {
		slog.Warn("poc run callback: url and secret are required; skipping registration",
			"task_id", uuidToString(taskID))
		return
	}
	if err := h.Queries.CreateRunCallback(ctx, db.CreateRunCallbackParams{
		TaskID:      taskID,
		WorkspaceID: workspaceID,
		Url:         url,
		Secret:      secret,
	}); err != nil {
		slog.Warn("poc run callback: failed to register",
			"task_id", uuidToString(taskID), "error", err)
	}
}

// PocGetRun returns the current state of a run as the existing AgentTaskResponse
// shape (status, result, error, timestamps, kind). A run is terminal when
// status is completed / failed / cancelled; `result` is populated on completed.
func (h *Handler) PocGetRun(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runId")

	workspaceID := h.resolveWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace_id is required (X-Workspace-ID header)")
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}

	runUUID, ok := parseUUIDOrBadRequest(w, runID, "run_id")
	if !ok {
		return
	}

	// Workspace-scoped lookup — no membership check (POC). A caller can only
	// read runs that belong to the workspace they name.
	task, err := h.Queries.GetAgentTaskInWorkspace(r.Context(), db.GetAgentTaskInWorkspaceParams{
		ID:          runUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "run not found in this workspace")
		return
	}

	writeJSON(w, http.StatusOK, taskToResponse(task, workspaceID))
}

// PocListRunMessages returns the persisted progress messages for a run, with
// optional ?since=<seq> catch-up — the same shape as the daemon-facing
// ListTaskMessages, exposed to unauthenticated POC callers.
func (h *Handler) PocListRunMessages(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runId")

	workspaceID := h.resolveWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace_id is required (X-Workspace-ID header)")
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}

	runUUID, ok := parseUUIDOrBadRequest(w, runID, "run_id")
	if !ok {
		return
	}

	// Verify the run belongs to the named workspace before reading messages.
	task, err := h.Queries.GetAgentTaskInWorkspace(r.Context(), db.GetAgentTaskInWorkspaceParams{
		ID:          runUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "run not found in this workspace")
		return
	}

	var (
		messages []db.TaskMessage
		listErr  error
	)
	if sinceStr := r.URL.Query().Get("since"); sinceStr != "" {
		sinceSeq, parseErr := strconv.Atoi(sinceStr)
		if parseErr != nil {
			writeError(w, http.StatusBadRequest, "invalid since parameter")
			return
		}
		messages, listErr = h.Queries.ListTaskMessagesSince(r.Context(), db.ListTaskMessagesSinceParams{
			TaskID: runUUID,
			Seq:    int32(sinceSeq),
		})
	} else {
		messages, listErr = h.Queries.ListTaskMessages(r.Context(), runUUID)
	}
	if listErr != nil {
		writeError(w, http.StatusInternalServerError, "failed to list run messages")
		return
	}

	issueID := uuidToString(task.IssueID)
	resp := make([]protocol.TaskMessagePayload, len(messages))
	for i, m := range messages {
		resp[i] = taskMessageToPayload(m, runID, issueID)
	}

	writeJSON(w, http.StatusOK, resp)
}