package agent

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestValidateSettingsPath covers the shared launch-time precondition check
// both the claude and opencode backends run before applying a settings file.
// A misconfigured path must surface as an error, not silently fall back to
// the CLI default — the user pinned the path expecting it to take effect.
func TestValidateSettingsPath(t *testing.T) {
	t.Parallel()

	existing := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(existing, []byte("{}"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	dir := t.TempDir()

	cases := []struct {
		name    string
		in      string
		want    string
		wantErr string // substring; empty means no error expected
	}{
		{name: "empty means no override", in: "", want: ""},
		{name: "whitespace only means no override", in: "   ", want: ""},
		{name: "valid file returns trimmed path", in: " " + existing + " ", want: existing},
		{name: "missing file errors", in: filepath.Join(dir, "nope.json"), wantErr: "settings file not accessible"},
		{name: "directory errors", in: dir, wantErr: "is a directory"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := validateSettingsPath(tc.in)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil (path=%q)", tc.wantErr, got)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("expected error containing %q, got %q", tc.wantErr, err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// TestBuildClaudeArgsBlocksSettingsCustomArg asserts --settings is blocked
// from custom_args: the per-agent settings_path field owns it, and two
// conflicting --settings values would be ambiguous.
func TestBuildClaudeArgsBlocksSettingsCustomArg(t *testing.T) {
	t.Parallel()

	args := buildClaudeArgs(ExecOptions{
		CustomArgs: []string{"--settings", "/tmp/evil.json", "--model", "o3"},
	}, slog.Default())

	for i, a := range args {
		if a == "--settings" {
			t.Fatalf("--settings should be blocked from custom_args, found at index %d: %v", i, args)
		}
		if a == "/tmp/evil.json" {
			t.Fatalf("--settings value should be consumed when blocking, found at index %d: %v", i, args)
		}
	}
	// Non-blocked args still pass through.
	foundModel := false
	for i, a := range args {
		if a == "--model" && i+1 < len(args) && args[i+1] == "o3" {
			foundModel = true
		}
	}
	if !foundModel {
		t.Fatalf("expected --model o3 to survive blocking: %v", args)
	}
}

// fakeClaudeScriptCapturingArgs writes its argv (one token per line) to the
// path in $CLAUDE_ARGV_CAPTURE, reads the initial stdin frame, and emits a
// clean result event so the backend completes normally.
func fakeClaudeScriptCapturingArgs() string {
	return `#!/bin/sh
IFS= read -r _
if [ -n "$CLAUDE_ARGV_CAPTURE" ]; then
  for a in "$@"; do printf '%s\n' "$a"; done > "$CLAUDE_ARGV_CAPTURE"
fi
printf '%s\n' '{"type":"system","session_id":"ses-settings"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-settings","result":"done"}'
`
}

// TestClaudeExecuteAppendsSettingsFlag is the end-to-end proof that a pinned
// settings file reaches the spawned claude process as --settings <path>.
func TestClaudeExecuteAppendsSettingsFlag(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}

	settingsFile := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(settingsFile, []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write settings fixture: %v", err)
	}

	tempDir := t.TempDir()
	fakePath := filepath.Join(tempDir, "claude")
	captureFile := filepath.Join(tempDir, "argv.txt")
	writeTestExecutable(t, fakePath, []byte(fakeClaudeScriptCapturingArgs()))

	backend, err := New("claude", Config{
		ExecutablePath: fakePath,
		Logger:         slog.Default(),
		Env:            map[string]string{"CLAUDE_ARGV_CAPTURE": captureFile},
	})
	if err != nil {
		t.Fatalf("new claude backend: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := backend.Execute(ctx, "prompt-ignored", ExecOptions{
		Timeout:      5 * time.Second,
		SettingsPath: settingsFile,
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	go func() {
		for range session.Messages {
		}
	}()
	if r := <-session.Result; r.Status != "completed" {
		t.Fatalf("status = %q, error = %q; want completed", r.Status, r.Error)
	}

	data, err := os.ReadFile(captureFile)
	if err != nil {
		t.Fatalf("read argv capture: %v", err)
	}
	tokens := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	foundFlag, foundValue := false, false
	for i, tok := range tokens {
		if tok == "--settings" {
			foundFlag = true
			if i+1 < len(tokens) && tokens[i+1] == settingsFile {
				foundValue = true
			}
		}
	}
	if !foundFlag {
		t.Fatalf("expected --settings in claude argv, got:\n%s", data)
	}
	if !foundValue {
		t.Fatalf("expected --settings %s in claude argv, got:\n%s", settingsFile, data)
	}
}

// TestClaudeExecuteRejectsMissingSettingsPath asserts a bad settings path
// fails the task before spawning claude (fail closed) rather than silently
// running with defaults.
func TestClaudeExecuteRejectsMissingSettingsPath(t *testing.T) {
	t.Parallel()

	// Use a real (fake) binary so exec.LookPath passes; the settings check
	// runs after LookPath and must reject the missing path before launch.
	fakePath := filepath.Join(t.TempDir(), "claude")
	writeTestExecutable(t, fakePath, []byte("#!/bin/sh\nexit 0\n"))

	backend, err := New("claude", Config{
		ExecutablePath: fakePath,
		Logger:         slog.Default(),
	})
	if err != nil {
		t.Fatalf("new claude backend: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = backend.Execute(ctx, "prompt-ignored", ExecOptions{
		Timeout:      5 * time.Second,
		SettingsPath: filepath.Join(t.TempDir(), "does-not-exist.json"),
	})
	if err == nil {
		t.Fatal("expected error for missing settings path, got nil")
	}
	if !strings.Contains(err.Error(), "settings file not accessible") {
		t.Fatalf("expected 'settings file not accessible' error, got %q", err.Error())
	}
}

// fakeOpencodeScriptCapturingConfig records $OPENCODE_CONFIG (the channel the
// opencode backend uses for a pinned settings file) to the capture file.
func fakeOpencodeScriptCapturingConfig() string {
	return `#!/bin/sh
if [ -n "$OPENCODE_CAPTURE_FILE" ]; then
  printf 'OPENCODE_CONFIG=%s\n' "${OPENCODE_CONFIG-<unset>}" > "$OPENCODE_CAPTURE_FILE"
fi
`
}

// TestOpencodeExecuteSetsOpencodeConfigEnv is the end-to-end proof that a
// pinned settings file reaches the spawned opencode process via OPENCODE_CONFIG.
func TestOpencodeExecuteSetsOpencodeConfigEnv(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}

	settingsFile := filepath.Join(t.TempDir(), "opencode.json")
	if err := os.WriteFile(settingsFile, []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write settings fixture: %v", err)
	}

	tempDir := t.TempDir()
	fakePath := filepath.Join(tempDir, "opencode")
	captureFile := filepath.Join(tempDir, "env-capture.txt")
	writeTestExecutable(t, fakePath, []byte(fakeOpencodeScriptCapturingConfig()))

	workDir := t.TempDir()
	backend, err := New("opencode", Config{
		ExecutablePath: fakePath,
		Logger:         slog.Default(),
		Env:            map[string]string{"OPENCODE_CAPTURE_FILE": captureFile},
	})
	if err != nil {
		t.Fatalf("new opencode backend: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := backend.Execute(ctx, "prompt-ignored", ExecOptions{
		Cwd:          workDir,
		Timeout:      5 * time.Second,
		SettingsPath: settingsFile,
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	go func() {
		for range session.Messages {
		}
	}()
	if r := <-session.Result; r.Status != "completed" {
		t.Fatalf("status = %q, error = %q; want completed", r.Status, r.Error)
	}

	captured := readCapturedEnv(t, captureFile)
	if got := captured["OPENCODE_CONFIG"]; got != settingsFile {
		t.Fatalf("OPENCODE_CONFIG = %q, want %q (full capture: %#v)", got, settingsFile, captured)
	}
}

// TestOpencodeExecuteRejectsMissingSettingsPath asserts a bad settings path
// fails the task before spawning opencode (fail closed).
func TestOpencodeExecuteRejectsMissingSettingsPath(t *testing.T) {
	t.Parallel()

	// Use a real (fake) binary so exec.LookPath passes; the settings check
	// runs after LookPath and must reject the missing path before launch.
	fakePath := filepath.Join(t.TempDir(), "opencode")
	writeTestExecutable(t, fakePath, []byte("#!/bin/sh\nexit 0\n"))

	backend, err := New("opencode", Config{
		ExecutablePath: fakePath,
		Logger:         slog.Default(),
	})
	if err != nil {
		t.Fatalf("new opencode backend: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = backend.Execute(ctx, "prompt-ignored", ExecOptions{
		Timeout:      5 * time.Second,
		SettingsPath: filepath.Join(t.TempDir(), "does-not-exist.json"),
	})
	if err == nil {
		t.Fatal("expected error for missing settings path, got nil")
	}
	if !strings.Contains(err.Error(), "settings file not accessible") {
		t.Fatalf("expected 'settings file not accessible' error, got %q", err.Error())
	}
}
