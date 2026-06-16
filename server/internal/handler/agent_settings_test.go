package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestCreateAgent_SettingsPath round-trips the settings_path field through
// the create endpoint: an explicit path is persisted and echoed back, and a
// whitespace-padded value is trimmed.
func TestCreateAgent_SettingsPath(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	claudeRuntimeID := createClaudeProviderRuntime(t)

	t.Cleanup(func() {
		testPool.Exec(ctx,
			`DELETE FROM agent WHERE workspace_id = $1 AND name LIKE 'settings-test-%'`,
			testWorkspaceID,
		)
	})

	t.Run("explicit path is echoed", func(t *testing.T) {
		body := map[string]any{
			"name":                 "settings-test-create",
			"runtime_id":           claudeRuntimeID,
			"visibility":           "private",
			"max_concurrent_tasks": 1,
			"settings_path":        "/home/user/.claude/settings-work.json",
		}
		w := httptest.NewRecorder()
		testHandler.CreateAgent(w, newRequest(http.MethodPost, "/api/agents", body))
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var resp map[string]any
		_ = json.NewDecoder(w.Body).Decode(&resp)
		if resp["settings_path"] != "/home/user/.claude/settings-work.json" {
			t.Errorf("expected settings_path echoed, got %v", resp["settings_path"])
		}
	})

	t.Run("whitespace is trimmed", func(t *testing.T) {
		body := map[string]any{
			"name":                 "settings-test-trim",
			"runtime_id":           claudeRuntimeID,
			"visibility":           "private",
			"max_concurrent_tasks": 1,
			"settings_path":        "   /x/settings.json   ",
		}
		w := httptest.NewRecorder()
		testHandler.CreateAgent(w, newRequest(http.MethodPost, "/api/agents", body))
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var resp map[string]any
		_ = json.NewDecoder(w.Body).Decode(&resp)
		if resp["settings_path"] != "/x/settings.json" {
			t.Errorf("expected trimmed settings_path, got %v", resp["settings_path"])
		}
	})
}

// TestUpdateAgent_SettingsPath_TriState covers the three PATCH modes for
// settings_path, mirroring the thinking_level contract:
//   - field omitted → leave the existing value alone
//   - explicit "" → clear back to NULL (response omits / empty)
//   - non-empty → set (trimmed)
func TestUpdateAgent_SettingsPath_TriState(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	claudeRuntimeID := createClaudeProviderRuntime(t)
	// Seed an agent with no settings_path, then set one via PATCH so the
	// "set" branch exercises the real write path.
	agentID := createAgentOnRuntime(t, "settings-update-test", claudeRuntimeID, "")

	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM agent WHERE id = $1`, agentID)
	})

	// 1. Set a value.
	t.Run("set value", func(t *testing.T) {
		body := map[string]any{
			"settings_path": "/home/user/.claude/settings-a.json",
		}
		w := httptest.NewRecorder()
		req := withURLParam(newRequest(http.MethodPatch, "/api/agents/"+agentID, body), "id", agentID)
		testHandler.UpdateAgent(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("set: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp map[string]any
		_ = json.NewDecoder(w.Body).Decode(&resp)
		if resp["settings_path"] != "/home/user/.claude/settings-a.json" {
			t.Errorf("set: expected settings_path echoed, got %v", resp["settings_path"])
		}
	})

	// 2. Omitted field — name-only update must NOT touch settings_path.
	t.Run("omitted field leaves value alone", func(t *testing.T) {
		body := map[string]any{
			"name": "settings-update-test-renamed",
		}
		w := httptest.NewRecorder()
		req := withURLParam(newRequest(http.MethodPatch, "/api/agents/"+agentID, body), "id", agentID)
		testHandler.UpdateAgent(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("name-only update: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp map[string]any
		_ = json.NewDecoder(w.Body).Decode(&resp)
		if resp["settings_path"] != "/home/user/.claude/settings-a.json" {
			t.Errorf("name-only update changed settings_path: got %v, want the previously-set value", resp["settings_path"])
		}
	})

	// 3. Explicit "" — must clear.
	t.Run("empty string clears", func(t *testing.T) {
		body := map[string]any{
			"settings_path": "",
		}
		w := httptest.NewRecorder()
		req := withURLParam(newRequest(http.MethodPatch, "/api/agents/"+agentID, body), "id", agentID)
		testHandler.UpdateAgent(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("clear update: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp map[string]any
		_ = json.NewDecoder(w.Body).Decode(&resp)
		if v, ok := resp["settings_path"]; ok && v != "" {
			t.Errorf("empty settings_path should clear: got %v", v)
		}
	})

	// 4. Re-set to confirm the clear actually persisted (round-trip), with trim.
	t.Run("re-set after clear trims whitespace", func(t *testing.T) {
		body := map[string]any{
			"settings_path": "   /home/user/.claude/settings-b.json   ",
		}
		w := httptest.NewRecorder()
		req := withURLParam(newRequest(http.MethodPatch, "/api/agents/"+agentID, body), "id", agentID)
		testHandler.UpdateAgent(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("re-set: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp map[string]any
		_ = json.NewDecoder(w.Body).Decode(&resp)
		if resp["settings_path"] != "/home/user/.claude/settings-b.json" {
			t.Errorf("re-set: expected trimmed settings_path, got %v", resp["settings_path"])
		}
	})
}
