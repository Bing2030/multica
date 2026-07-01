package handler

// poc_runs_test.go covers the unauthenticated POC runs API
// (server/internal/handler/poc_runs.go). The handlers are invoked directly —
// the MULTICA_ENABLE_POC_RUNS_API env gate only controls route mounting in
// router.go, which these tests bypass by calling the handler methods.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// resolvePocRuntimeAndAgent bumps the seeded runtime's CLI metadata past the
// quick-create daemon-version gate and returns (runtimeID, agentID) for the
// handler test workspace. Mirrors the setup in
// TestQuickCreateIssueParentTrustBoundary.
func resolvePocRuntimeAndAgent(t *testing.T) (string, string) {
	t.Helper()
	ctx := context.Background()

	var runtimeID, agentID string
	if err := testPool.QueryRow(ctx,
		`SELECT id FROM agent_runtime WHERE workspace_id = $1 LIMIT 1`,
		testWorkspaceID,
	).Scan(&runtimeID); err != nil {
		t.Fatalf("fetch runtime: %v", err)
	}
	if err := testPool.QueryRow(ctx,
		`SELECT id FROM agent WHERE workspace_id = $1 LIMIT 1`,
		testWorkspaceID,
	).Scan(&agentID); err != nil {
		t.Fatalf("fetch agent: %v", err)
	}
	if _, err := testPool.Exec(ctx,
		`UPDATE agent_runtime SET metadata = jsonb_build_object('cli_version', $1::text) WHERE id = $2`,
		agent.MinQuickCreateCLIVersion, runtimeID,
	); err != nil {
		t.Fatalf("bump runtime cli_version: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`UPDATE agent_runtime SET metadata = '{}'::jsonb WHERE id = $1`, runtimeID)
	})
	return runtimeID, agentID
}

func TestPocTriggerRunHappyPath(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	_, agentID := resolvePocRuntimeAndAgent(t)

	body := map[string]string{
		"workspace_id": testWorkspaceID,
		"agent_id":     agentID,
		"prompt":       "Create an issue titled 'poc runs api smoke test'",
	}
	req := newRequest(http.MethodPost, "/api/poc/runs", body)
	rec := httptest.NewRecorder()
	testHandler.PocTriggerRun(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("trigger: want 202, got %d (body=%s)", rec.Code, rec.Body.String())
	}

	var resp PocTriggerRunResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("trigger: decode response: %v (body=%s)", err, rec.Body.String())
	}
	if resp.RunID == "" {
		t.Fatal("trigger: run_id is empty")
	}
	if resp.Status != "queued" {
		t.Fatalf("trigger: status want queued, got %q", resp.Status)
	}
	if resp.AgentID != agentID {
		t.Fatalf("trigger: agent_id want %q, got %q", agentID, resp.AgentID)
	}
	if resp.WorkspaceID != testWorkspaceID {
		t.Fatalf("trigger: workspace_id want %q, got %q", testWorkspaceID, resp.WorkspaceID)
	}

	t.Cleanup(func() {
		// Best-effort cleanup of the queued task row so the suite stays
		// hermetic. The daemon isn't running in tests, so the task never
		// leaves 'queued' — deleting by id is safe.
		testPool.Exec(context.Background(),
			`DELETE FROM agent_task_queue WHERE id = $1`, resp.RunID)
	})

	// GET /api/poc/runs/{runId} — newRequest already sets X-Workspace-ID.
	getReq := withURLParam(newRequest(http.MethodGet, "/api/poc/runs/"+resp.RunID, nil), "runId", resp.RunID)
	getRec := httptest.NewRecorder()
	testHandler.PocGetRun(getRec, getReq)

	if getRec.Code != http.StatusOK {
		t.Fatalf("get run: want 200, got %d (body=%s)", getRec.Code, getRec.Body.String())
	}
	var run AgentTaskResponse
	if err := json.Unmarshal(getRec.Body.Bytes(), &run); err != nil {
		t.Fatalf("get run: decode: %v (body=%s)", err, getRec.Body.String())
	}
	if run.ID != resp.RunID {
		t.Fatalf("get run: id want %q, got %q", resp.RunID, run.ID)
	}
	if run.Status != "queued" {
		t.Fatalf("get run: status want queued, got %q", run.Status)
	}
	if run.Kind != "quick_create" {
		t.Fatalf("get run: kind want quick_create, got %q", run.Kind)
	}
	if run.WorkspaceID != testWorkspaceID {
		t.Fatalf("get run: workspace_id want %q, got %q", testWorkspaceID, run.WorkspaceID)
	}

	// GET /api/poc/runs/{runId}/messages — no daemon ran, so messages is empty.
	msgReq := withURLParam(newRequest(http.MethodGet, "/api/poc/runs/"+resp.RunID+"/messages", nil), "runId", resp.RunID)
	msgRec := httptest.NewRecorder()
	testHandler.PocListRunMessages(msgRec, msgReq)

	if msgRec.Code != http.StatusOK {
		t.Fatalf("list messages: want 200, got %d (body=%s)", msgRec.Code, msgRec.Body.String())
	}
	var msgs []json.RawMessage
	if err := json.Unmarshal(msgRec.Body.Bytes(), &msgs); err != nil {
		t.Fatalf("list messages: decode: %v (body=%s)", err, msgRec.Body.String())
	}
	if len(msgs) != 0 {
		t.Fatalf("list messages: want empty array, got %d items", len(msgs))
	}
}

func TestPocTriggerRunValidation(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	_, agentID := resolvePocRuntimeAndAgent(t)

	cases := []struct {
		name string
		body map[string]string
		want int
	}{
		{"empty prompt", map[string]string{"workspace_id": testWorkspaceID, "agent_id": agentID, "prompt": "   "}, http.StatusBadRequest},
		{"missing agent_id", map[string]string{"workspace_id": testWorkspaceID, "prompt": "do something"}, http.StatusBadRequest},
		{"bogus agent_id", map[string]string{"workspace_id": testWorkspaceID, "agent_id": "not-a-uuid", "prompt": "do something"}, http.StatusBadRequest},
		{"bogus workspace_id", map[string]string{"workspace_id": "not-a-uuid", "agent_id": agentID, "prompt": "do something"}, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := newRequest(http.MethodPost, "/api/poc/runs", c.body)
			rec := httptest.NewRecorder()
			testHandler.PocTriggerRun(rec, req)
			if rec.Code != c.want {
				t.Fatalf("want %d, got %d (body=%s)", c.want, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestPocGetRunForeignWorkspaceRejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	_, agentID := resolvePocRuntimeAndAgent(t)

	// Trigger in the home workspace to get a real run id.
	triggerReq := newRequest(http.MethodPost, "/api/poc/runs", map[string]string{
		"workspace_id": testWorkspaceID,
		"agent_id":     agentID,
		"prompt":       "poc foreign-workspace probe",
	})
	triggerRec := httptest.NewRecorder()
	testHandler.PocTriggerRun(triggerRec, triggerReq)
	if triggerRec.Code != http.StatusAccepted {
		t.Fatalf("trigger: want 202, got %d (body=%s)", triggerRec.Code, triggerRec.Body.String())
	}
	var resp PocTriggerRunResponse
	if err := json.Unmarshal(triggerRec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("trigger: decode: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_task_queue WHERE id = $1`, resp.RunID)
	})

	// Create a foreign workspace and request the run scoped to it. The run
	// belongs to the home workspace, so the workspace-scoped lookup must 404.
	ctx := context.Background()
	var foreignWorkspaceID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO workspace (name, slug, description, issue_prefix)
		VALUES ($1, $2, $3, $4) RETURNING id
	`, "POC Foreign", "poc-foreign-ws", "temporary foreign workspace for poc test", "POC").Scan(&foreignWorkspaceID); err != nil {
		t.Fatalf("create foreign workspace: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, foreignWorkspaceID)
	})

	req := withURLParam(newRequest(http.MethodGet, "/api/poc/runs/"+resp.RunID, nil), "runId", resp.RunID)
	req.Header.Set("X-Workspace-ID", foreignWorkspaceID)
	rec := httptest.NewRecorder()
	testHandler.PocGetRun(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign-workspace get: want 404, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

// TestPocTriggerRunDirectMode verifies mode=direct enqueues a direct_run task
// (context.type == "direct_run") rather than a quick-create task, and that an
// invalid mode is rejected.
func TestPocTriggerRunDirectMode(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	_, agentID := resolvePocRuntimeAndAgent(t)

	// direct mode → context.type == direct_run
	req := newRequest(http.MethodPost, "/api/poc/runs", map[string]string{
		"workspace_id": testWorkspaceID,
		"agent_id":     agentID,
		"prompt":       "Summarize the auth module and return the summary",
		"mode":         "direct",
	})
	rec := httptest.NewRecorder()
	testHandler.PocTriggerRun(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("direct trigger: want 202, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var resp PocTriggerRunResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("direct trigger: decode: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_task_queue WHERE id = $1`, resp.RunID)
	})

	var ctxType string
	if err := testPool.QueryRow(context.Background(),
		`SELECT context->>'type' FROM agent_task_queue WHERE id = $1`, resp.RunID,
	).Scan(&ctxType); err != nil {
		t.Fatalf("load task context: %v", err)
	}
	if ctxType != service.DirectRunContextType {
		t.Fatalf("direct mode: context.type want %q, got %q", service.DirectRunContextType, ctxType)
	}

	// invalid mode → 400
	badReq := newRequest(http.MethodPost, "/api/poc/runs", map[string]string{
		"workspace_id": testWorkspaceID,
		"agent_id":     agentID,
		"prompt":       "do something",
		"mode":         "bogus",
	})
	badRec := httptest.NewRecorder()
	testHandler.PocTriggerRun(badRec, badReq)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode: want 400, got %d (body=%s)", badRec.Code, badRec.Body.String())
	}
}

// TestPocTriggerRunRegistersCallback verifies that supplying result_callback on
// the trigger persists a poc_run_callback row keyed to the run, so the
// run-callback subscriber can deliver on completion. Complements
// cmd/server.TestDeliverRunCallbackEndToEnd (the deliver half).
func TestPocTriggerRunRegistersCallback(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	_, agentID := resolvePocRuntimeAndAgent(t)

	req := newRequest(http.MethodPost, "/api/poc/runs", map[string]any{
		"workspace_id": testWorkspaceID,
		"agent_id":     agentID,
		"prompt":       "callback smoke test",
		"mode":         "direct",
		"result_callback": map[string]string{
			"url":    "https://client.example/runs/callback",
			"secret": "topsecret",
		},
	})
	rec := httptest.NewRecorder()
	testHandler.PocTriggerRun(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("trigger: want 202, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var resp PocTriggerRunResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("trigger: decode: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_task_queue WHERE id = $1`, resp.RunID)
	})

	var url, status string
	if err := testPool.QueryRow(context.Background(),
		`SELECT url, status FROM poc_run_callback WHERE task_id = $1`, resp.RunID,
	).Scan(&url, &status); err != nil {
		t.Fatalf("callback row not persisted: %v", err)
	}
	if url != "https://client.example/runs/callback" {
		t.Fatalf("callback url want client.example, got %q", url)
	}
	if status != "queued" {
		t.Fatalf("callback status want queued, got %q", status)
	}
}