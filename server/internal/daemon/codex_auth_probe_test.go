package daemon

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/taskfailure"
)

// newProbeDaemon builds a Daemon wired only enough for the codex auth probe:
// cfg.Agents["codex"].Path selects the binary the probe will exec, and the
// auth-probe cache is initialized empty. No client, runtimes, or workspaces.
func newProbeDaemon(t *testing.T, codexPath string) *Daemon {
	t.Helper()
	return &Daemon{
		cfg:            Config{Agents: map[string]AgentEntry{"codex": {Path: codexPath}}},
		logger:         slog.Default(),
		authProbeCache: make(map[string]authProbeResult),
	}
}

// writeFakeCodexLoginStatus writes an executable shell script that emulates
// `codex login status` with a chosen stdout, stderr, and exit code.
func writeFakeCodexLoginStatus(t *testing.T, stdout, stderr string, exitCode int) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-codex")
	body := "#!/bin/sh\n"
	if stdout != "" {
		body += "printf %s " + shQuote(stdout) + "\n"
	}
	if stderr != "" {
		body += "printf %s " + shQuote(stderr) + " 1>&2\n"
	}
	body += "exit " + itoa(exitCode) + "\n"
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	return path
}

// shQuote single-quotes a string for safe embedding in a sh script.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// itoa avoids importing strconv just for one call site.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func TestProbeCodexAuth_AuthedWhenLoggedIn(t *testing.T) {
	t.Parallel()
	path := writeFakeCodexLoginStatus(t, "Logged in using ChatGPT\n", "", 0)
	d := newProbeDaemon(t, path)

	got := d.probeCodexAuth(context.Background())
	if got.state != "authed" {
		t.Fatalf("expected authed, got %q (msg=%q)", got.state, got.msg)
	}
}

func TestProbeCodexAuth_NotAuthedOnNonZeroExit(t *testing.T) {
	t.Parallel()
	path := writeFakeCodexLoginStatus(t, "", "not logged in: run `codex login`\n", 1)
	d := newProbeDaemon(t, path)

	got := d.probeCodexAuth(context.Background())
	if got.state != "not_authed" {
		t.Fatalf("expected not_authed, got %q (msg=%q)", got.state, got.msg)
	}
	if !strings.Contains(got.msg, "not logged in") {
		t.Fatalf("expected captured stderr in msg, got %q", got.msg)
	}
}

func TestProbeCodexAuth_NotAuthedWhenNoLoggedInToken(t *testing.T) {
	t.Parallel()
	// Exit 0 but the output lacks "logged in" — codex could in principle print
	// a neutral status; treat it as not authenticated.
	path := writeFakeCodexLoginStatus(t, "unknown auth state\n", "", 0)
	d := newProbeDaemon(t, path)

	got := d.probeCodexAuth(context.Background())
	if got.state != "not_authed" {
		t.Fatalf("expected not_authed for status without 'logged in', got %q", got.state)
	}
}

func TestProbeCodexAuth_UnknownWhenBinaryMissing(t *testing.T) {
	t.Parallel()
	// Point at a path that does not exist — exec fails, probe must fail open.
	d := newProbeDaemon(t, filepath.Join(t.TempDir(), "no-such-binary"))

	got := d.probeCodexAuth(context.Background())
	if got.state != "unknown" {
		t.Fatalf("expected unknown (fail-open) for missing binary, got %q", got.state)
	}
}

func TestCodexAuthState_ServesFreshCache(t *testing.T) {
	t.Parallel()
	path := writeFakeCodexLoginStatus(t, "Logged in using ChatGPT\n", "", 0)
	d := newProbeDaemon(t, path)
	// Seed a not_authed entry that is still fresh — the cached value must win
	// and the probe (which would return authed) must NOT run.
	d.authProbeCache["codex"] = authProbeResult{state: "not_authed", checkedAt: time.Now()}

	if got := d.codexAuthState(); got != "not_authed" {
		t.Fatalf("expected cached not_authed to be served, got %q", got)
	}
}

func TestCodexAuthState_ReprobesWhenStale(t *testing.T) {
	t.Parallel()
	path := writeFakeCodexLoginStatus(t, "Logged in using ChatGPT\n", "", 0)
	d := newProbeDaemon(t, path)
	// Seed a stale not_authed entry (older than authProbeStaleAfter) — the
	// probe must re-run and return the live authed state.
	d.authProbeCache["codex"] = authProbeResult{
		state:     "not_authed",
		checkedAt: time.Now().Add(-authProbeStaleAfter - time.Minute),
	}

	if got := d.codexAuthState(); got != "authed" {
		t.Fatalf("expected stale cache to trigger re-probe -> authed, got %q", got)
	}
}

func TestInvalidateCodexAuthCache_ForcesReprobe(t *testing.T) {
	t.Parallel()
	path := writeFakeCodexLoginStatus(t, "Logged in using ChatGPT\n", "", 0)
	d := newProbeDaemon(t, path)
	d.authProbeCache["codex"] = authProbeResult{state: "not_authed", checkedAt: time.Now()}

	d.invalidateCodexAuthCache()
	if got := d.codexAuthState(); got != "authed" {
		t.Fatalf("expected invalidate -> re-probe -> authed, got %q", got)
	}
}

// TestClassifyTimeoutFailureReason pins the Fix 1b reason-override matrix:
// auth/quota signals win and mark the cache for invalidation; a bare codex
// no-progress marker falls back to the resume-unsafe inactivity bucket; a
// non-codex provider timeout with a 5xx surfaces the server-error reason;
// no signal at all stays a plain timeout.
func TestClassifyTimeoutFailureReason(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name              string
		provider          string
		comment           string
		wantReason        string
		wantClassified    bool
		wantInvalidateAuth bool
	}{
		{
			name:              "codex auth 401 wins over timeout",
			provider:          "codex",
			comment:           "codex app-server no progress timeout; codex retry errors: 401 Unauthorized: ChatGPT login required",
			wantReason:        taskfailure.ReasonAgentProviderAuthOrAccess.String(),
			wantClassified:    true,
			wantInvalidateAuth: true,
		},
		{
			name:              "codex quota 402 wins over timeout",
			provider:          "codex",
			comment:           "codex app-server no progress timeout; codex retry errors: 402 Payment Required: quota exceeded",
			wantReason:        taskfailure.ReasonAgentProviderQuotaLimit.String(),
			wantClassified:    true,
			wantInvalidateAuth: false, // quota is not an auth-probe signal
		},
		{
			name:           "codex bare no-progress marker falls back to inactivity",
			provider:       "codex",
			comment:        agent.CodexFirstTurnNoProgressMarker + ": no turn/started within 30s",
			wantReason:     FailureReasonCodexSemanticInactivity,
			wantClassified: false,
		},
		{
			name:           "non-codex provider 503 surfaces server-error",
			provider:       "claude",
			comment:        "claude timed out after 30s; upstream 503 internal server error",
			wantReason:     taskfailure.ReasonAgentProviderServerError.String(),
			wantClassified: true,
		},
		{
			name:           "no provider signal stays plain timeout",
			provider:       "claude",
			comment:        "claude timed out after 30s",
			wantReason:     "timeout",
			wantClassified: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			reason, classified, invalidateAuth := classifyTimeoutFailureReason(tc.provider, tc.comment)
			if reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", reason, tc.wantReason)
			}
			if classified != tc.wantClassified {
				t.Errorf("classified = %v, want %v", classified, tc.wantClassified)
			}
			if invalidateAuth != tc.wantInvalidateAuth {
				t.Errorf("invalidateAuthCache = %v, want %v", invalidateAuth, tc.wantInvalidateAuth)
			}
		})
	}
}