package main

// run_callback_listeners_test.go covers the outbound webhook channel for the
// runs-as-a-service POC (RFC channel 2): the HMAC signer round-trip, the
// payload builder, and an end-to-end DB-backed delivery that asserts a signed
// POST reaches the registered target.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// TestSignRunCallbackRoundTrip locks in the outbound signing contract: the
// server-emitted X-Multica-Signature verifies against the shared secret over
// the raw body, and a tampered body / wrong secret fails.
func TestSignRunCallbackRoundTrip(t *testing.T) {
	secret := "s3cret"
	body := []byte(`{"event":"run.completed","run_id":"abc"}`)

	sig := signRunCallback(secret, body)
	if !verifyRunCallbackSignature(secret, sig, body) {
		t.Fatalf("signature did not verify: %s", sig)
	}
	// Tampered body must fail.
	if verifyRunCallbackSignature(secret, sig, []byte(`{"event":"run.completed","run_id":"tampered"}`)) {
		t.Fatal("signature verified against a tampered body")
	}
	// Wrong secret must fail.
	if verifyRunCallbackSignature("wrong", sig, body) {
		t.Fatal("signature verified with the wrong secret")
	}
	// Malformed header must fail (not panic).
	if verifyRunCallbackSignature(secret, "not-a-real-signature", body) {
		t.Fatal("malformed signature header verified")
	}
}

// TestSignRunCallbackScheme asserts the header carries the documented
// sha256=<hex> prefix so a client knows what to strip before hex-decoding.
func TestSignRunCallbackScheme(t *testing.T) {
	sig := signRunCallback("k", []byte("body"))
	if len(sig) < 8 || sig[:7] != "sha256=" {
		t.Fatalf("signature missing sha256= prefix: %q", sig)
	}
}

// TestBuildRunCallbackPayload asserts the payload carries the terminal run
// state the RFC documents: event name, ids, status, result (unmarshalled from
// the task JSONB), error, timestamps, attempt.
func TestBuildRunCallbackPayload(t *testing.T) {
	task := db.AgentTaskQueue{
		ID:        pgtype.UUID{Bytes: [16]byte{1, 2, 3}, Valid: true},
		AgentID:   pgtype.UUID{Bytes: [16]byte{4, 5, 6}, Valid: true},
		Status:    "completed",
		Result:    []byte(`{"output":"the answer","pr_url":"https://x"}`),
		Attempt:   2,
		StartedAt: pgtype.Timestamptz{Time: time.Date(2026, 6, 25, 9, 0, 0, 0, time.UTC), Valid: true},
		CompletedAt: pgtype.Timestamptz{Time: time.Date(2026, 6, 25, 9, 1, 0, 0, time.UTC), Valid: true},
	}
	cb := db.PocRunCallback{
		TaskID:      task.ID,
		WorkspaceID: pgtype.UUID{Bytes: [16]byte{7, 8, 9}, Valid: true},
	}

	p := buildRunCallbackPayload(protocol.EventTaskCompleted, task, cb)

	if p.Event != "run.completed" {
		t.Fatalf("event want run.completed, got %q", p.Event)
	}
	if p.Status != "completed" {
		t.Fatalf("status want completed, got %q", p.Status)
	}
	if p.Result["output"] != "the answer" {
		t.Fatalf("result.output want 'the answer', got %v", p.Result["output"])
	}
	if p.Attempt != 2 {
		t.Fatalf("attempt want 2, got %d", p.Attempt)
	}
	if p.StartedAt == "" || p.CompletedAt == "" {
		t.Fatalf("timestamps must be set: started=%q completed=%q", p.StartedAt, p.CompletedAt)
	}
}

// TestDeliverRunCallbackEndToEnd drives the full outbound path against a test
// HTTP server: a completed task + registered callback → the subscriber POSTs a
// signed body, the target records it, and the callback row flips to
// 'delivered'. Requires the migration 121 table applied to the test DB.
func TestDeliverRunCallbackEndToEnd(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	queries := db.New(testPool)

	var (
		gotSig   string
		gotEvent string
		gotBody  []byte
	)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSig = r.Header.Get("X-Multica-Signature")
		gotEvent = r.Header.Get("X-Multica-Event")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	// Seed a completed direct_run task in the test workspace.
	var agentID string
	if err := testPool.QueryRow(ctx,
		`SELECT id::text FROM agent WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1`,
		testWorkspaceID,
	).Scan(&agentID); err != nil {
		t.Fatalf("load fixture agent: %v", err)
	}
	var runtimeID string
	if err := testPool.QueryRow(ctx,
		`SELECT runtime_id::text FROM agent WHERE id = $1`, agentID,
	).Scan(&runtimeID); err != nil {
		t.Fatalf("load agent runtime: %v", err)
	}

	var taskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, status, result, attempt)
		VALUES ($1, $2, 'completed', '{"output":"42"}'::jsonb, 1)
		RETURNING id::text
	`, agentID, runtimeID).Scan(&taskID); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
	})

	secret := "shared-secret"
	if err := queries.CreateRunCallback(ctx, db.CreateRunCallbackParams{
		TaskID:      parseUUID(taskID),
		WorkspaceID: parseUUID(testWorkspaceID),
		Url:         target.URL,
		Secret:      secret,
	}); err != nil {
		t.Fatalf("create callback: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM poc_run_callback WHERE task_id = $1`, taskID)
	})

	client := &http.Client{Timeout: 5 * time.Second}
	deliverRunCallback(ctx, queries, client, taskID, protocol.EventTaskCompleted)

	// The POST must have carried a signature that verifies against the secret
	// over the body the target actually received.
	if gotSig == "" {
		t.Fatal("target received no X-Multica-Signature header")
	}
	if !verifyRunCallbackSignature(secret, gotSig, gotBody) {
		t.Fatalf("delivered signature did not verify against received body (sig=%s)", gotSig)
	}
	if gotEvent != "run.completed" {
		t.Fatalf("X-Multica-Event want run.completed, got %q", gotEvent)
	}
	var payload runCallbackPayload
	if err := json.Unmarshal(gotBody, &payload); err != nil {
		t.Fatalf("delivered body is not valid JSON: %v (body=%s)", err, gotBody)
	}
	if payload.Status != "completed" || payload.Result["output"] != "42" {
		t.Fatalf("unexpected payload: %+v", payload)
	}

	// The callback row must be recorded as delivered.
	cb, err := queries.GetRunCallbackByTask(ctx, parseUUID(taskID))
	if err != nil {
		t.Fatalf("reload callback: %v", err)
	}
	if cb.Status != "delivered" {
		t.Fatalf("callback status want delivered, got %q (last_error=%s)", cb.Status, cb.LastError.String)
	}
}

// TestDeliverRunCallbackNoCallbackNoOps asserts a terminal event for a run
// with no registered callback is a silent no-op (the common case: most runs
// are in-app, not service-triggered).
func TestDeliverRunCallbackNoCallbackNoOps(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	queries := db.New(testPool)

	// A task UUID that does not exist → no callback row → return before any
	// network call. Use a parseable but nonexistent UUID.
	bogus := "00000000-0000-0000-0000-000000000000"
	called := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	_ = target

	deliverRunCallback(ctx, queries, &http.Client{Timeout: time.Second}, bogus, protocol.EventTaskCompleted)
	if called {
		t.Fatal("delivered a POST for a run with no registered callback")
	}
}
