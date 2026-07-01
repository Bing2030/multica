package main

// run_callback_listeners.go implements the outbound webhook channel for the
// "agent runs as a service" POC (RFC channel 2). When a run that registered a
// per-run result_callback reaches a terminal status, this listener POSTs a
// signed payload to the registered URL and records the delivery outcome in
// poc_run_callback.
//
// There is no outbound HTTP worker anywhere else in the codebase (the existing
// webhook_delivery.go + autopilot_webhook.go are inbound only). For the POC
// delivery happens INLINE in the event subscriber: a terminal task event
// fires synchronously on the completing goroutine, the subscriber looks up a
// callback row, and POSTs with a short timeout. A production-grade worker
// (queued rows drained by a background loop with backoff/retry, modeled on
// runRuntimeSweeper) is a documented follow-up, not part of this POC.
//
// The signing scheme is the inverse of the inbound verifyHubSignature helper
// (server/internal/handler/autopilot_webhook.go:262): the same GitHub-
// compatible `sha256=<hex(hmac-sha256(body, secret))>`, plus an
// X-Multica-Timestamp for replay-window checking. A client verifies by
// recomputing the HMAC over the raw body and comparing constant-time.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// runCallbackHTTPTimeout caps a single outbound delivery. Runs complete on the
// daemon's callback goroutine; an unresponsive target must not wedge that
// goroutine for long.
const runCallbackHTTPTimeout = 10 * time.Second

// runCallbackQuerier is the narrow subset of *db.Queries the listener uses.
// Declared as an interface so the delivery logic is unit-testable without a
// full *db.Queries.
type runCallbackQuerier interface {
	GetRunCallbackByTask(ctx context.Context, taskID pgtype.UUID) (db.PocRunCallback, error)
	GetAgentTask(ctx context.Context, id pgtype.UUID) (db.AgentTaskQueue, error)
	UpdateRunCallbackDelivered(ctx context.Context, arg db.UpdateRunCallbackDeliveredParams) error
	UpdateRunCallbackFailed(ctx context.Context, arg db.UpdateRunCallbackFailedParams) error
}

// registerRunCallbackListeners subscribes to terminal task events and delivers
// any registered per-run result_callback. No-op when the POC API is disabled
// (MULTICA_ENABLE_POC_RUNS_API != "1"): no trigger endpoint means no callback
// rows can ever exist, so subscribing would be wasted work.
func registerRunCallbackListeners(bus *events.Bus, queries runCallbackQuerier, client *http.Client) {
	if os.Getenv("MULTICA_ENABLE_POC_RUNS_API") != "1" {
		return
	}
	ctx := context.Background()
	deliver := func(e events.Event) {
		payload, ok := e.Payload.(map[string]any)
		if !ok {
			return
		}
		taskID, _ := payload["task_id"].(string)
		if taskID == "" {
			return
		}
		deliverRunCallback(ctx, queries, client, taskID, e.Type)
	}
	bus.Subscribe(protocol.EventTaskCompleted, deliver)
	bus.Subscribe(protocol.EventTaskFailed, deliver)
	bus.Subscribe(protocol.EventTaskCancelled, deliver)
}

// eventNameFor maps a protocol task event type to the outbound webhook event
// name (run.completed | run.failed | run.cancelled).
func eventNameFor(eventType string) string {
	switch eventType {
	case protocol.EventTaskCompleted:
		return "run.completed"
	case protocol.EventTaskFailed:
		return "run.failed"
	case protocol.EventTaskCancelled:
		return "run.cancelled"
	default:
		return eventType
	}
}

// deliverRunCallback fetches the callback + task rows, builds the signed
// payload, POSTs it, and records the outcome. Best-effort throughout: every
// failure path logs and marks the callback row failed rather than panicking,
// because this runs on the task-completion goroutine and must never block the
// daemon's completion path.
func deliverRunCallback(ctx context.Context, queries runCallbackQuerier, client *http.Client, taskID, eventType string) {
	taskUUID, err := util.ParseUUID(taskID)
	if err != nil {
		return
	}

	cb, err := queries.GetRunCallbackByTask(ctx, taskUUID)
	if err != nil {
		// No callback registered for this run — the common case (most runs are
		// in-app, not service-triggered). Not an error.
		return
	}
	if cb.Status == "delivered" {
		// Already delivered (e.g. a duplicate terminal event). Don't re-POST.
		return
	}

	task, err := queries.GetAgentTask(ctx, taskUUID)
	if err != nil {
		slog.Warn("run callback: failed to load task for payload", "task_id", taskID, "error", err)
		markRunCallbackFailed(ctx, queries, cb.TaskID, pgtype.Int4{}, "failed to load task: "+err.Error())
		return
	}

	body, err := json.Marshal(buildRunCallbackPayload(eventType, task, cb))
	if err != nil {
		slog.Warn("run callback: failed to marshal payload", "task_id", taskID, "error", err)
		markRunCallbackFailed(ctx, queries, cb.TaskID, pgtype.Int4{}, "failed to marshal payload: "+err.Error())
		return
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cb.Url, bytes.NewReader(body))
	if err != nil {
		markRunCallbackFailed(ctx, queries, cb.TaskID, pgtype.Int4{}, "invalid callback url: "+err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Multica-Event", eventNameFor(eventType))
	req.Header.Set("X-Multica-Signature", signRunCallback(cb.Secret, body))
	req.Header.Set("X-Multica-Timestamp", strconv.FormatInt(time.Now().Unix(), 10))

	resp, err := client.Do(req)
	if err != nil {
		slog.Warn("run callback: delivery failed", "task_id", taskID, "url", cb.Url, "error", err)
		markRunCallbackFailed(ctx, queries, cb.TaskID, pgtype.Int4{}, "delivery failed: "+err.Error())
		return
	}
	// Drain + close so the connection can be reused.
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if err := queries.UpdateRunCallbackDelivered(ctx, db.UpdateRunCallbackDeliveredParams{
			TaskID:             cb.TaskID,
			LastResponseStatus: pgtype.Int4{Int32: int32(resp.StatusCode), Valid: true},
		}); err != nil {
			slog.Warn("run callback: failed to record delivery", "task_id", taskID, "error", err)
		}
		slog.Info("run callback delivered",
			"task_id", taskID, "url", cb.Url, "status", resp.StatusCode)
		return
	}

	slog.Warn("run callback: non-2xx response", "task_id", taskID, "url", cb.Url, "status", resp.StatusCode)
	markRunCallbackFailed(ctx, queries, cb.TaskID, pgtype.Int4{Int32: int32(resp.StatusCode), Valid: true},
		"non-2xx status: "+strconv.Itoa(resp.StatusCode))
}

func markRunCallbackFailed(ctx context.Context, queries runCallbackQuerier, taskID pgtype.UUID, status pgtype.Int4, reason string) {
	if err := queries.UpdateRunCallbackFailed(ctx, db.UpdateRunCallbackFailedParams{
		TaskID:             taskID,
		LastResponseStatus: status,
		LastError:          pgtype.Text{String: reason, Valid: reason != ""},
	}); err != nil {
		slog.Warn("run callback: failed to record failure", "task_id", taskID, "error", err)
	}
}

// runCallbackPayload is the outbound webhook body shape. Mirrors the existing
// AgentTaskResponse contract (task.result is whatever the agent wrote) so a
// client reuses the same parsing logic. `result` is intentionally
// map[string]any (not a typed struct) because result is untrusted agent
// output — parse defensively, per the project's API Response Compatibility
// rules.
type runCallbackPayload struct {
	Event         string         `json:"event"`
	RunID         string         `json:"run_id"`
	WorkspaceID   string         `json:"workspace_id"`
	AgentID       string         `json:"agent_id"`
	IssueID       string         `json:"issue_id"`
	Status        string         `json:"status"`
	Result        map[string]any `json:"result,omitempty"`
	Error         *string        `json:"error,omitempty"`
	FailureReason string         `json:"failure_reason,omitempty"`
	StartedAt     string         `json:"started_at,omitempty"`
	CompletedAt   string         `json:"completed_at,omitempty"`
	Attempt       int32          `json:"attempt"`
}

func buildRunCallbackPayload(eventType string, task db.AgentTaskQueue, cb db.PocRunCallback) runCallbackPayload {
	var result map[string]any
	if len(task.Result) > 0 {
		// A malformed result must not break delivery — fall back to nil so the
		// payload still ships with the rest of the fields.
		_ = json.Unmarshal(task.Result, &result)
	}
	var errMsg *string
	if task.Error.Valid {
		s := task.Error.String
		errMsg = &s
	}
	return runCallbackPayload{
		Event:         eventNameFor(eventType),
		RunID:         util.UUIDToString(task.ID),
		WorkspaceID:   util.UUIDToString(cb.WorkspaceID),
		AgentID:       util.UUIDToString(task.AgentID),
		IssueID:       util.UUIDToString(task.IssueID),
		Status:        task.Status,
		Result:        result,
		Error:         errMsg,
		FailureReason: task.FailureReason.String,
		StartedAt:     timestampRFC3339(task.StartedAt),
		CompletedAt:   timestampRFC3339(task.CompletedAt),
		Attempt:       task.Attempt,
	}
}

func timestampRFC3339(t pgtype.Timestamptz) string {
	if !t.Valid {
		return ""
	}
	return t.Time.UTC().Format(time.RFC3339Nano)
}

// signRunCallback computes the outbound HMAC-SHA256 signature over body — the
// inverse of the inbound verifyHubSignature scheme
// (server/internal/handler/autopilot_webhook.go:262). Returns the full
// "sha256=<hex>" header value a client puts in X-Multica-Signature.
func signRunCallback(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// verifyRunCallbackSignature is the client-side check: constant-time compare of
// a recomputed HMAC against a received header. Exported for tests and for any
// client that wants to mirror the server's own verify helper.
func verifyRunCallbackSignature(secret, header string, body []byte) bool {
	const prefix = "sha256="
	if len(header) <= len(prefix) || header[:len(prefix)] != prefix {
		return false
	}
	want, err := hex.DecodeString(header[len(prefix):])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(mac.Sum(nil), want)
}