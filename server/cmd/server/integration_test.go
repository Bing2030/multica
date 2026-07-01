package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/realtime"
)

var (
	testServer      *httptest.Server
	testPool        *pgxpool.Pool
	testToken       string
	testUserID      string
	testWorkspaceID string
)

// THROWAWAY POC: under DevBypass the server stamps the canonical dev user
// (middleware.DevBypassEmail) on every request regardless of the Authorization
// header, so testToken is a dummy and the fixture seeds that same dev user as
// the workspace owner — testUserID is the actor DevBypass stamps end-to-end.
// NEVER MERGE.

const (
	integrationTestWorkspaceSlug = "integration-tests"
	// integrationTestEmail is the email of the workspace/agent owner the
	// fixture seeds — under DevBypass that's the canonical dev user, so tests
	// that look up "the test agent" by owner email resolve to the same user
	// DevBypass stamps as the actor.
	integrationTestEmail = middleware.DevBypassEmail
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://multica:multica@localhost:5432/multica?sslmode=disable"
	}

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		fmt.Printf("Skipping integration tests: could not connect to database: %v\n", err)
		os.Exit(0)
	}
	if err := pool.Ping(ctx); err != nil {
		fmt.Printf("Skipping integration tests: database not reachable: %v\n", err)
		pool.Close()
		os.Exit(0)
	}

	testPool = pool
	testUserID, testWorkspaceID, err = setupIntegrationTestFixture(ctx, pool)
	if err != nil {
		fmt.Printf("Failed to set up integration test fixture: %v\n", err)
		pool.Close()
		os.Exit(1)
	}

	hub := realtime.NewHub()
	go hub.Run()

	bus := events.New()
	registerListeners(bus, hub)
	router := NewRouter(pool, hub, bus, nil)
	testServer = httptest.NewServer(router)

	// THROWAWAY POC: DevBypass ignores the Authorization header, so a dummy
	// token is fine (and the requests that still send it are rewritten in
	// Phase 6). NEVER MERGE.
	testToken = "devbypass-dummy-token"

	code := m.Run()

	if err := cleanupIntegrationTestFixture(context.Background(), pool); err != nil {
		fmt.Printf("Failed to clean up integration test fixture: %v\n", err)
		if code == 0 {
			code = 1
		}
	}
	testServer.Close()
	pool.Close()
	os.Exit(code)
}

func setupIntegrationTestFixture(ctx context.Context, pool *pgxpool.Pool) (string, string, error) {
	if err := cleanupIntegrationTestFixture(ctx, pool); err != nil {
		return "", "", err
	}

	// THROWAWAY POC: under DevBypass every request's actor is the canonical dev
	// user (dev@multica.local, see middleware.DevBypassEmail). The suite uses
	// testUserID as the creator/actor in both direct DB inserts and router
	// requests, so the fixture MUST seed that same dev user and make it the
	// owner of the integration-tests workspace — otherwise the stamped actor
	// isn't a member and every /api/* call 404s with "workspace not found".
	// DevBypass's ensureDevBypassUser finds this row via GetUserByEmail, so the
	// stamped X-User-ID equals testUserID end-to-end. NEVER MERGE.
	var userID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO "user" (name, email)
		VALUES ($1, $2)
		ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
		RETURNING id
	`, middleware.DevBypassName, middleware.DevBypassEmail).Scan(&userID); err != nil {
		return "", "", err
	}

	var workspaceID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workspace (name, slug, description)
		VALUES ($1, $2, $3)
		RETURNING id
	`, "Integration Tests", integrationTestWorkspaceSlug, "Temporary workspace for router integration tests").Scan(&workspaceID); err != nil {
		return "", "", err
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO member (workspace_id, user_id, role)
		VALUES ($1, $2, 'owner')
		ON CONFLICT DO NOTHING
	`, workspaceID, userID); err != nil {
		return "", "", err
	}

	var runtimeID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_runtime (
			workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, last_seen_at
		)
		VALUES ($1, NULL, $2, 'cloud', $3, 'online', $4, '{}'::jsonb, now())
		RETURNING id
	`, workspaceID, "Integration Test Runtime", "integration_test_runtime", "Integration test runtime").Scan(&runtimeID); err != nil {
		return "", "", err
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO agent (
			workspace_id, name, description, runtime_mode, runtime_config,
			runtime_id, visibility, max_concurrent_tasks, owner_id
		)
		VALUES ($1, $2, '', 'cloud', '{}'::jsonb, $3, 'workspace', 1, $4)
	`, workspaceID, "Integration Test Agent", runtimeID, userID); err != nil {
		return "", "", err
	}

	return userID, workspaceID, nil
}

func cleanupIntegrationTestFixture(ctx context.Context, pool *pgxpool.Pool) error {
	// Drop the integration-tests workspace (cascades members/issues/agents/
	// runtimes). The dev user is shared with DevBypass provisioning, so it is
	// intentionally left in place across runs.
	if _, err := pool.Exec(ctx, `DELETE FROM workspace WHERE slug = $1`, integrationTestWorkspaceSlug); err != nil {
		return err
	}
	return nil
}

// Helper to make authenticated requests
func authRequest(t *testing.T, method, path string, body any) *http.Response {
	t.Helper()
	var bodyReader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		bodyReader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, testServer.URL+path, bodyReader)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("X-Workspace-ID", testWorkspaceID)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	return resp
}

func readJSON(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
}

// ---- Health ----

func TestHealth(t *testing.T) {
	resp, err := http.Get(testServer.URL + "/health")
	if err != nil {
		t.Fatalf("health check failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var result map[string]string
	json.NewDecoder(resp.Body).Decode(&result)
	if result["status"] != "ok" {
		t.Fatalf("expected status ok, got %s", result["status"])
	}
}

func TestReadinessEndpoints(t *testing.T) {
	for _, path := range []string{"/readyz", "/healthz"} {
		t.Run(path, func(t *testing.T) {
			resp, err := http.Get(testServer.URL + path)
			if err != nil {
				t.Fatalf("readiness check failed: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				t.Fatalf("expected 200, got %d", resp.StatusCode)
			}

			var result struct {
				Status string            `json:"status"`
				Checks map[string]string `json:"checks"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if result.Status != "ok" {
				t.Fatalf("expected status ok, got %s", result.Status)
			}
			if result.Checks["db"] != "ok" {
				t.Fatalf("expected db check ok, got %s", result.Checks["db"])
			}
			if result.Checks["migrations"] != "ok" {
				t.Fatalf("expected migrations check ok, got %s", result.Checks["migrations"])
			}
		})
	}
}

func TestConfigRouteIsPublic(t *testing.T) {
	resp, err := http.Get(testServer.URL + "/api/config")
	if err != nil {
		t.Fatalf("config request failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
	}

	var result struct {
		CdnDomain string `json:"cdn_domain"`
	}
	readJSON(t, resp, &result)
}

// ---- Issues CRUD through full router ----

func TestIssuesCRUDThroughRouter(t *testing.T) {
	// Create
	resp := authRequest(t, "POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":    "Integration test issue",
		"status":   "todo",
		"priority": "high",
	})
	if resp.StatusCode != 201 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("CreateIssue: expected 201, got %d: %s", resp.StatusCode, body)
	}

	var created map[string]any
	readJSON(t, resp, &created)
	issueID := created["id"].(string)
	if created["title"] != "Integration test issue" {
		t.Fatalf("expected title 'Integration test issue', got '%s'", created["title"])
	}

	// Get
	resp = authRequest(t, "GET", "/api/issues/"+issueID, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("GetIssue: expected 200, got %d", resp.StatusCode)
	}
	var fetched map[string]any
	readJSON(t, resp, &fetched)
	if fetched["id"] != issueID {
		t.Fatalf("expected id %s, got %s", issueID, fetched["id"])
	}

	// Update status only — should preserve title
	resp = authRequest(t, "PUT", "/api/issues/"+issueID, map[string]any{
		"status": "in_progress",
	})
	if resp.StatusCode != 200 {
		t.Fatalf("UpdateIssue: expected 200, got %d", resp.StatusCode)
	}
	var updated map[string]any
	readJSON(t, resp, &updated)
	if updated["status"] != "in_progress" {
		t.Fatalf("expected status 'in_progress', got '%s'", updated["status"])
	}
	if updated["title"] != "Integration test issue" {
		t.Fatalf("title should be preserved, got '%s'", updated["title"])
	}

	// Update title only — should preserve status
	resp = authRequest(t, "PUT", "/api/issues/"+issueID, map[string]any{
		"title": "Renamed integration issue",
	})
	if resp.StatusCode != 200 {
		t.Fatalf("UpdateIssue title: expected 200, got %d", resp.StatusCode)
	}
	var updated2 map[string]any
	readJSON(t, resp, &updated2)
	if updated2["title"] != "Renamed integration issue" {
		t.Fatalf("expected title 'Renamed integration issue', got '%s'", updated2["title"])
	}
	if updated2["status"] != "in_progress" {
		t.Fatalf("status should be preserved, got '%s'", updated2["status"])
	}

	// List
	resp = authRequest(t, "GET", "/api/issues?workspace_id="+testWorkspaceID, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("ListIssues: expected 200, got %d", resp.StatusCode)
	}
	var listResp map[string]any
	readJSON(t, resp, &listResp)
	total := listResp["total"].(float64)
	if total < 1 {
		t.Fatal("expected at least 1 issue")
	}

	// Delete
	resp = authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
	resp.Body.Close()
	if resp.StatusCode != 204 {
		t.Fatalf("DeleteIssue: expected 204, got %d", resp.StatusCode)
	}

	// Verify deleted
	resp = authRequest(t, "GET", "/api/issues/"+issueID, nil)
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("GetIssue after delete: expected 404, got %d", resp.StatusCode)
	}
}

// ---- Comments through full router ----

func TestCommentsThroughRouter(t *testing.T) {
	// Create issue
	resp := authRequest(t, "POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title": "Comment integration test",
	})
	var issue map[string]any
	readJSON(t, resp, &issue)
	issueID := issue["id"].(string)

	// Create comment
	resp = authRequest(t, "POST", "/api/issues/"+issueID+"/comments", map[string]any{
		"content": "Integration test comment",
		"type":    "comment",
	})
	if resp.StatusCode != 201 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("CreateComment: expected 201, got %d: %s", resp.StatusCode, body)
	}
	var comment map[string]any
	readJSON(t, resp, &comment)
	if comment["content"] != "Integration test comment" {
		t.Fatalf("expected content 'Integration test comment', got '%s'", comment["content"])
	}

	// Create second comment
	resp = authRequest(t, "POST", "/api/issues/"+issueID+"/comments", map[string]any{
		"content": "Second comment",
		"type":    "comment",
	})
	resp.Body.Close()

	// List comments
	resp = authRequest(t, "GET", "/api/issues/"+issueID+"/comments", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("ListComments: expected 200, got %d", resp.StatusCode)
	}
	var comments []map[string]any
	readJSON(t, resp, &comments)
	if len(comments) != 2 {
		t.Fatalf("expected 2 comments, got %d", len(comments))
	}

	// Cleanup
	resp = authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
	resp.Body.Close()
}

// ---- Agents through full router ----

func TestAgentsThroughRouter(t *testing.T) {
	// List
	resp := authRequest(t, "GET", "/api/agents?workspace_id="+testWorkspaceID, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("ListAgents: expected 200, got %d", resp.StatusCode)
	}
	var agents []map[string]any
	readJSON(t, resp, &agents)
	if len(agents) < 1 {
		t.Fatal("expected at least 1 agent")
	}

	// Get
	agentID := agents[0]["id"].(string)
	resp = authRequest(t, "GET", "/api/agents/"+agentID, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("GetAgent: expected 200, got %d", resp.StatusCode)
	}
	var agent map[string]any
	readJSON(t, resp, &agent)
	if agent["id"] != agentID {
		t.Fatalf("expected agent id %s, got %s", agentID, agent["id"])
	}

	// Update status
	resp = authRequest(t, "PUT", "/api/agents/"+agentID, map[string]any{
		"status": "idle",
	})
	if resp.StatusCode != 200 {
		t.Fatalf("UpdateAgent: expected 200, got %d", resp.StatusCode)
	}
	var updated map[string]any
	readJSON(t, resp, &updated)
	if updated["status"] != "idle" {
		t.Fatalf("expected status 'idle', got '%s'", updated["status"])
	}
	// Name should be preserved
	if updated["name"] != agents[0]["name"] {
		t.Fatalf("name should be preserved, got '%s'", updated["name"])
	}
}

// ---- Workspaces through full router ----

func TestWorkspacesThroughRouter(t *testing.T) {
	// List
	resp := authRequest(t, "GET", "/api/workspaces", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("ListWorkspaces: expected 200, got %d", resp.StatusCode)
	}
	var workspaces []map[string]any
	readJSON(t, resp, &workspaces)
	if len(workspaces) < 1 {
		t.Fatal("expected at least 1 workspace")
	}

	// Get
	wsID := workspaces[0]["id"].(string)
	resp = authRequest(t, "GET", "/api/workspaces/"+wsID, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("GetWorkspace: expected 200, got %d", resp.StatusCode)
	}
	var ws map[string]any
	readJSON(t, resp, &ws)
	if ws["id"] != wsID {
		t.Fatalf("expected workspace id %s, got %s", wsID, ws["id"])
	}

	// Update
	resp = authRequest(t, "PUT", "/api/workspaces/"+wsID, map[string]any{
		"description": "Integration test update",
	})
	if resp.StatusCode != 200 {
		t.Fatalf("UpdateWorkspace: expected 200, got %d", resp.StatusCode)
	}
	var updated map[string]any
	readJSON(t, resp, &updated)
	if updated["description"] != "Integration test update" {
		t.Fatalf("expected description 'Integration test update', got '%v'", updated["description"])
	}
	// Name should be preserved
	if updated["name"] != ws["name"] {
		t.Fatalf("name should be preserved")
	}

	// Members
	resp = authRequest(t, "GET", "/api/workspaces/"+wsID+"/members", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("ListMembers: expected 200, got %d", resp.StatusCode)
	}
	var members []map[string]any
	readJSON(t, resp, &members)
	if len(members) < 1 {
		t.Fatal("expected at least 1 member")
	}
	// Verify member has user info
	if members[0]["email"] == nil || members[0]["email"] == "" {
		t.Fatal("member should have email field")
	}
	if members[0]["role"] == nil || members[0]["role"] == "" {
		t.Fatal("member should have role field")
	}
}

// TestDeleteWorkspaceRequiresOwner is a defense-in-depth regression test for the
// permission gate on DELETE /api/workspaces/{id}. It creates a separate workspace
// in which the integration test user is only an "admin" (not "owner") and asserts
// that DELETE returns 403, leaving the workspace intact. This guards against both
// router misconfiguration (missing middleware) and handler regressions.
func TestDeleteWorkspaceRequiresOwner(t *testing.T) {
	ctx := context.Background()

	const slug = "integration-tests-delete-403"
	// Best-effort cleanup from any prior run.
	_, _ = testPool.Exec(ctx, `DELETE FROM workspace WHERE slug = $1`, slug)

	var wsID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO workspace (name, slug, description)
		VALUES ($1, $2, $3)
		RETURNING id
	`, "Integration Tests Delete 403", slug, "DeleteWorkspace permission test").Scan(&wsID); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, wsID)
	})

	if _, err := testPool.Exec(ctx, `
		INSERT INTO member (workspace_id, user_id, role)
		VALUES ($1, $2, 'admin')
	`, wsID, testUserID); err != nil {
		t.Fatalf("create admin member: %v", err)
	}

	req, err := http.NewRequest("DELETE", testServer.URL+"/api/workspaces/"+wsID, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("X-Workspace-ID", wsID)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for non-owner DELETE, got %d", resp.StatusCode)
	}

	var exists bool
	if err := testPool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace WHERE id = $1)`, wsID).Scan(&exists); err != nil {
		t.Fatalf("verify workspace: %v", err)
	}
	if !exists {
		t.Fatal("workspace was deleted despite non-owner request")
	}
}

// ---- Inbox through full router ----

func TestInboxThroughRouter(t *testing.T) {
	resp := authRequest(t, "GET", "/api/inbox", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("ListInbox: expected 200, got %d", resp.StatusCode)
	}
	var items []map[string]any
	readJSON(t, resp, &items)
	// Inbox may be empty, just verify it returns valid JSON array
	if items == nil {
		t.Fatal("expected non-nil inbox items array")
	}
}

// ---- 404 for non-existent resources ----

func TestNonExistentResources(t *testing.T) {
	fakeUUID := "00000000-0000-0000-0000-000000000000"

	cases := []struct {
		name string
		path string
	}{
		{"issue", "/api/issues/" + fakeUUID},
		{"agent", "/api/agents/" + fakeUUID},
		{"workspace", "/api/workspaces/" + fakeUUID},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := authRequest(t, "GET", tc.path, nil)
			resp.Body.Close()
			if resp.StatusCode != 404 {
				t.Fatalf("expected 404, got %d", resp.StatusCode)
			}
		})
	}
}

// ---- Invalid request bodies ----

func TestInvalidRequestBodies(t *testing.T) {
	resp := authRequest(t, "POST", "/api/issues?workspace_id="+testWorkspaceID, nil)
	defer resp.Body.Close()
	// Sending nil body should fail with 400
	if resp.StatusCode != 400 {
		// Some handlers may return 500 for nil body, that's acceptable too
		if resp.StatusCode != 500 {
			t.Fatalf("expected 400 or 500, got %d", resp.StatusCode)
		}
	}
}

// ---- WebSocket integration through full router ----

func TestWebSocketIntegration(t *testing.T) {
	// THROWAWAY POC: /ws goes through DevBypass, which stamps X-User-ID (the
	// dev user) on the upgrade request. HandleWebSocket reads that header as
	// the connection identity and checks workspace membership — no
	// first-message auth, no auth_ack. The dev user owns the integration-tests
	// workspace (fixture), so the upgrade succeeds. NEVER MERGE.
	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/ws?workspace_id=" + testWorkspaceID
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("WebSocket connection failed: %v", err)
	}
	defer conn.Close()

	// Allow Hub goroutine to process the register and add client to room
	time.Sleep(100 * time.Millisecond)

	// Create an issue — this should trigger a WebSocket broadcast
	resp := authRequest(t, "POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":  "WebSocket test issue",
		"status": "todo",
	})
	var issue map[string]any
	readJSON(t, resp, &issue)
	issueID := issue["id"].(string)

	// Read the WebSocket message
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("WebSocket read error: %v", err)
	}

	// Verify the message contains the issue event
	var wsMsg map[string]any
	if err := json.Unmarshal(msg, &wsMsg); err != nil {
		t.Fatalf("failed to parse WebSocket message: %v", err)
	}
	if wsMsg["type"] != "issue:created" {
		t.Fatalf("expected type 'issue:created', got '%s'", wsMsg["type"])
	}

	// Update the issue — should trigger another broadcast
	resp = authRequest(t, "PUT", "/api/issues/"+issueID, map[string]any{
		"status": "in_progress",
	})
	resp.Body.Close()

	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err = conn.ReadMessage()
	if err != nil {
		t.Fatalf("WebSocket read error on update: %v", err)
	}
	var updateMsg map[string]any
	json.Unmarshal(msg, &updateMsg)
	if updateMsg["type"] != "issue:updated" {
		t.Fatalf("expected type 'issue:updated', got '%s'", updateMsg["type"])
	}

	// Delete the issue — should trigger another broadcast
	resp = authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
	resp.Body.Close()

	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err = conn.ReadMessage()
	if err != nil {
		t.Fatalf("WebSocket read error on delete: %v", err)
	}
	var deleteMsg map[string]any
	json.Unmarshal(msg, &deleteMsg)
	if deleteMsg["type"] != "issue:deleted" {
		t.Fatalf("expected type 'issue:deleted', got '%s'", deleteMsg["type"])
	}
}
