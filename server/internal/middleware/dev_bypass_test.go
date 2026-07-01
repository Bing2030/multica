package middleware

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// integrationPool returns a pool against DATABASE_URL, or skips the test if
// Postgres is not reachable. Mirrors the pattern in
// server/internal/scheduler/stale_steal_test.go and the handler TestMain.
func integrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://multica:multica@localhost:5432/multica?sslmode=disable"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Skipf("dev bypass test requires Postgres: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("dev bypass test requires Postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestDevBypassProvisionsOnboardedUser pins the login-skip behavior: after
// resolveDevBypassUserID runs, the dev user must have onboarded_at set so the
// frontend (AuthInitializer + RedirectIfAuthenticated) lands in the dashboard
// instead of routing through /onboarding. MarkUserOnboarded is idempotent
// (COALESCE(onboarded_at, now())), so this holds whether the user was just
// created or already existed.
//
// Non-destructive: it does NOT delete the dev user, so it is safe to run while
// a `make dev` server is using that user (the dev user/workspace are shared).
// The invariant — "resolved dev user is onboarded" — is what the login skip
// relies on, and it is fully covered here. On a freshly-reset DB the user is
// created by the call, so the assertion exercises the MarkUserOnboarded path.
func TestDevBypassProvisionsOnboardedUser(t *testing.T) {
	pool := integrationPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	ResetDevBypassUser() // clear this process's id cache + provisioned flag

	id := resolveDevBypassUserID(ctx, queries)
	if id == "" {
		t.Fatal("expected non-empty dev user id")
	}

	user, err := queries.GetUserByEmail(ctx, DevBypassEmail)
	if err != nil {
		t.Fatalf("GetUserByEmail: %v", err)
	}
	if !user.OnboardedAt.Valid {
		t.Error("expected dev user onboarded_at to be set; MarkUserOnboarded did not run during provisioning")
	}
	if user.ID.String() != id {
		t.Errorf("returned id %q does not match resolved user id %q", id, user.ID.String())
	}
}
