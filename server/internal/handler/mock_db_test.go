package handler

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// mockDB / mockRow back the Handler unit tests that need to drive a sqlc
// Queries instance against a controllable DB error (e.g. daemon_test.go's
// transient-DB-error case). They implement just enough of the pgx DBTX
// interface for db.New() to compile; only the QueryRow / Exec paths the
// tests actually exercise are wired up.
type mockDB struct {
	db.DBTX
	getUserErr error
}

func (m *mockDB) QueryRow(ctx context.Context, sql string, args ...interface{}) pgx.Row {
	return &mockRow{err: m.getUserErr}
}

func (m *mockDB) Exec(ctx context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("INSERT 1"), nil
}

type mockRow struct {
	pgx.Row
	err error
}

func (m *mockRow) Scan(dest ...interface{}) error {
	return m.err
}