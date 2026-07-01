package middleware

import (
	"context"
)

// THROWAWAY POC: the DaemonAuth middleware constructor (mdt_ / mcn_ / mul_ /
// JWT token validation) is removed — DevBypass stamps X-User-ID and the daemon
// routes run with no token. The daemon context helpers below are kept because
// the daemon handlers and their tests still read workspace/daemon IDs from the
// request context (DevBypass stamps them the same way DaemonAuth did). NEVER
// MERGE.

// Daemon context keys.
type daemonContextKey int

const (
	ctxKeyDaemonWorkspaceID daemonContextKey = iota
	ctxKeyDaemonID
	ctxKeyDaemonAuthPath
)

// Daemon auth path labels exposed via context for slow-log attribution.
const (
	DaemonAuthPathDaemonToken = "daemon_token"
	DaemonAuthPathPAT         = "pat"
	DaemonAuthPathCloudPAT    = "cloud_pat"
	DaemonAuthPathJWT         = "jwt"
)

// DaemonWorkspaceIDFromContext returns the workspace ID set on the daemon
// request context.
func DaemonWorkspaceIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(ctxKeyDaemonWorkspaceID).(string)
	return id
}

// DaemonIDFromContext returns the daemon ID set on the daemon request context.
func DaemonIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(ctxKeyDaemonID).(string)
	return id
}

// DaemonAuthPathFromContext returns which token kind authenticated this
// request — "daemon_token", "pat", "cloud_pat", or "jwt" — for telemetry.
// Empty when the request did not pass through a token-based daemon auth path
// (under DevBypass this is the common case).
func DaemonAuthPathFromContext(ctx context.Context) string {
	p, _ := ctx.Value(ctxKeyDaemonAuthPath).(string)
	return p
}

// WithDaemonContext returns a new context with the daemon workspace ID and daemon ID set.
// This is used by tests to simulate daemon token authentication.
func WithDaemonContext(ctx context.Context, workspaceID, daemonID string) context.Context {
	ctx = context.WithValue(ctx, ctxKeyDaemonWorkspaceID, workspaceID)
	ctx = context.WithValue(ctx, ctxKeyDaemonID, daemonID)
	ctx = context.WithValue(ctx, ctxKeyDaemonAuthPath, DaemonAuthPathDaemonToken)
	return ctx
}