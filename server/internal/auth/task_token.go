package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// THROWAWAY POC: the user-facing auth surface (JWT secret, PAT/daemon-token
// generation, cookie/CSRF helpers) lived in jwt.go / cookie.go / pat_cache.go /
// daemon_token_cache.go / cloud_pat.go and has been deleted — DevBypass is the
// sole identity path. Only the agent task-token helpers remain here, because
// the daemon still mints single-purpose "mat_" tokens for agents claiming tasks
// (see internal/handler/daemon.go, MUL-2600) — that flow is independent of the
// removed user/daemon login. NEVER MERGE.

// CloudPATPrefix is the literal token prefix that identifies an mcn_ Cloud
// Node PAT. Kept as a constant so the CLI (cmd/multica) still recognizes the
// prefix in `multica login --token` validation; the cloud-PAT *verifier* that
// consumed it server-side is gone with the rest of the login surface.
const CloudPATPrefix = "mcn_"

// GenerateAgentTaskToken creates a new task-scoped agent auth token:
// "mat_" + 40 random hex chars. The token is single-purpose — bound to a
// specific (agent_id, task_id) pair on the server side — and is what the
// daemon injects into the agent process in place of its own owner PAT.
// See MUL-2600.
func GenerateAgentTaskToken() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate agent task token: %w", err)
	}
	return "mat_" + hex.EncodeToString(b), nil
}

// HashToken returns the hex-encoded SHA-256 hash of a token string.
func HashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}