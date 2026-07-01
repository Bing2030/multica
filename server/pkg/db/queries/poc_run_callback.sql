-- =====================
-- POC Run Callback (outbound webhook delivery for runs-as-a-service)
-- =====================
-- See migration 121_poc_run_callback.up.sql and
-- docs/agent-runs-as-a-service-rfc.md (channel 2). POC only.

-- name: CreateRunCallback :exec
-- Idempotent: a retried trigger for the same task replaces nothing (the task
-- is already queued). ON CONFLICT DO NOTHING keeps a stale callback from a
-- prior attempt from being silently overwritten by a newer one.
INSERT INTO poc_run_callback (task_id, workspace_id, url, secret)
VALUES ($1, $2, $3, $4)
ON CONFLICT (task_id) DO NOTHING;

-- name: GetRunCallbackByTask :one
SELECT * FROM poc_run_callback WHERE task_id = $1;

-- name: UpdateRunCallbackDelivered :exec
-- Records a successful outbound delivery: 2xx response. Bumps attempt_count
-- so a retry-then-succeed sequence is visible. Clears last_error.
UPDATE poc_run_callback
SET status = 'delivered',
    attempt_count = attempt_count + 1,
    last_response_status = sqlc.narg('last_response_status'),
    last_error = NULL,
    delivered_at = now(),
    updated_at = now()
WHERE task_id = $1;

-- name: UpdateRunCallbackFailed :exec
-- Records a failed outbound delivery (non-2xx, transport error, or signing
-- failure). status='failed' so a future retry worker (production follow-up)
-- could pick it up; for the POC this is terminal.
UPDATE poc_run_callback
SET status = 'failed',
    attempt_count = attempt_count + 1,
    last_response_status = sqlc.narg('last_response_status'),
    last_error = sqlc.narg('last_error'),
    updated_at = now()
WHERE task_id = $1;