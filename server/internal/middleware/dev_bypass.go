package middleware

// dev_bypass.go is a THROWAWAY auth-bypass middleware for the runs-as-a-service
// POC. It stamps a fixed dev user identity (X-User-ID) onto every request and
// performs NO token validation whatsoever. router.go wires it IN PLACE OF both
// Auth (user routes) and DaemonAuth (daemon routes), so the entire
// /api/* and /api/daemon/* surface is open.
//
// On first use it lazily creates a canonical dev user AND a dev workspace
// (with the dev user as owner), so the app works from a freshly-reset database
// and lands directly in the dashboard. The daemon routes fall back to an
// X-User-ID membership check when no daemon-token context is set, so stamping
// X-User-ID here authorizes daemon register/claim/start/complete too.
//
// ⚠️ NEVER MERGE THIS. It disables ALL authentication. It exists only so a
// local POC of the runs-as-a-service API and the desktop app run without
// login/tokens.

import (
	"context"
	"log/slog"
	"net/http"
	"sync"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	// DevBypassEmail and DevBypassName are exported so test fixtures (e.g. the
	// cmd/server integration suite) can seed the exact dev user DevBypass
	// stamps, keeping their testUserID == the request actor end-to-end.
	DevBypassEmail    = "dev@multica.local"
	DevBypassName     = "Dev User"
	devBypassWsSlug   = "multica-dev"
	devBypassWsName   = "Local Dev"
	devBypassWsPrefix = "DEV"
	devBypassWsDesc   = "Auto-provisioned dev workspace (POC auth bypass)"
)

var (
	devBypassIDMu sync.Mutex
	devBypassID   string
	// devBypassProvisionedDone gates the workspace+membership provisioning so
	// it runs at most once per process (on the first cache miss).
	devBypassProvisionedDone bool
)

// ResetDevBypassUser clears the cached dev user id. Exported for tests that
// re-seed the user table between runs.
func ResetDevBypassUser() {
	devBypassIDMu.Lock()
	defer devBypassIDMu.Unlock()
	devBypassID = ""
	devBypassProvisionedDone = false
}

// resolveDevBypassUserID returns the canonical dev user's UUID, creating the
// row on first use, and (once per process) ensures the dev user owns a dev
// workspace so the app lands in the dashboard and the daemon has a workspace
// to register against. Cached after first resolution so the hot path is a
// single mutex-protected string read.
func resolveDevBypassUserID(ctx context.Context, queries *db.Queries) string {
	devBypassIDMu.Lock()
	if devBypassID != "" {
		id := devBypassID
		devBypassIDMu.Unlock()
		return id
	}
	devBypassIDMu.Unlock()

	if queries == nil {
		return ""
	}

	userID := ensureDevBypassUser(ctx, queries)
	if !userID.Valid {
		return ""
	}

	// Provision the workspace exactly once per process.
	devBypassIDMu.Lock()
	done := devBypassProvisionedDone
	devBypassProvisionedDone = true
	devBypassIDMu.Unlock()
	if !done {
		// Mark the dev user onboarded so the frontend lands directly in the
		// dev workspace dashboard instead of routing through /onboarding
		// (which a fresh dev user would otherwise hit, since CreateUser
		// leaves onboarded_at NULL). Idempotent: MarkUserOnboarded uses
		// COALESCE(onboarded_at, now()), so a user who already completed
		// onboarding in a prior session keeps their timestamp.
		if _, err := queries.MarkUserOnboarded(ctx, userID); err != nil {
			slog.Warn("dev bypass: failed to mark dev user onboarded", "error", err)
		}
		ensureDevBypassWorkspace(ctx, queries, userID)
	}
	return cacheDevBypassUser(userID)
}

// ensureDevBypassUser finds or creates the canonical dev user and returns its
// UUID (uncached — caching is the caller's job).
func ensureDevBypassUser(ctx context.Context, queries *db.Queries) pgtype.UUID {
	if u, err := queries.GetUserByEmail(ctx, DevBypassEmail); err == nil {
		return u.ID
	}
	u, err := queries.CreateUser(ctx, db.CreateUserParams{
		Name:      DevBypassName,
		Email:     DevBypassEmail,
		AvatarUrl: pgtype.Text{},
	})
	if err != nil {
		// Concurrent create raced us — re-lookup is the recovery path.
		if u2, err2 := queries.GetUserByEmail(ctx, DevBypassEmail); err2 == nil {
			return u2.ID
		}
		slog.Error("dev bypass: failed to create dev user", "error", err)
		return pgtype.UUID{}
	}
	return u.ID
}

// ensureDevBypassWorkspace creates the dev workspace (if absent) and makes the
// dev user its owner. Best-effort: every failure is logged and swallowed
// because this runs on the request hot path on first hit and must never break
// the request. Idempotent across restarts (lookup-by-slug).
func ensureDevBypassWorkspace(ctx context.Context, queries *db.Queries, userID pgtype.UUID) {
	ws, err := queries.GetWorkspaceBySlug(ctx, devBypassWsSlug)
	if err != nil {
		ws, err = queries.CreateWorkspace(ctx, db.CreateWorkspaceParams{
			Name:        devBypassWsName,
			Slug:        devBypassWsSlug,
			Description: pgtype.Text{String: devBypassWsDesc, Valid: true},
			Context:     pgtype.Text{String: "{}", Valid: true},
			IssuePrefix: devBypassWsPrefix,
		})
		if err != nil {
			// Collision / race — try to load the existing one.
			if ws2, err2 := queries.GetWorkspaceBySlug(ctx, devBypassWsSlug); err2 == nil {
				ws = ws2
			} else {
				slog.Warn("dev bypass: failed to provision dev workspace", "error", err)
				return
			}
		}
	}
	// Make the dev user an owner if not already a member.
	if _, err := queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		UserID:      userID,
		WorkspaceID: ws.ID,
	}); err == nil {
		return
	}
	if _, err := queries.CreateMember(ctx, db.CreateMemberParams{
		WorkspaceID: ws.ID,
		UserID:      userID,
		Role:        "owner",
	}); err != nil {
		slog.Warn("dev bypass: failed to make dev user a workspace owner", "error", err)
	}
}

func cacheDevBypassUser(id pgtype.UUID) string {
	s := util.UUIDToString(id)
	devBypassIDMu.Lock()
	devBypassID = s
	devBypassIDMu.Unlock()
	return s
}

// DevBypass is the unconditional auth-bypass middleware. It stamps X-User-ID
// with the dev user and calls next without validating any credential. Used in
// router.go to replace both Auth (user routes) and DaemonAuth (daemon routes).
//
// The daemon routes' workspace-access helper falls back to an X-User-ID
// membership check when no daemon-token context is set, so stamping X-User-ID
// here is sufficient to authorize daemon register/claim/start/complete too.
func DevBypass(queries *db.Queries) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// X-Actor-Source is server-set only — keep stripping client-supplied
			// values so a caller can't forge actor identity even in bypass mode.
			r.Header.Del("X-Actor-Source")
			if id := resolveDevBypassUserID(r.Context(), queries); id != "" {
				r.Header.Set("X-User-ID", id)
			}
			next.ServeHTTP(w, r)
		})
	}
}