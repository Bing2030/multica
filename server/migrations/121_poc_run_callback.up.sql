-- POC outbound webhook delivery for "agent runs as a service" (RFC channel 2).
--
-- One row per run that registered a per-run result_callback at trigger time.
-- The run-callback Bus subscriber (cmd/server/run_callback_listeners.go) reads
-- this on task:completed / failed / cancelled, POSTs the signed run payload to
-- `url`, and records the outcome here. The HMAC secret is the inverse of the
-- inbound verifyHubSignature scheme: X-Multica-Signature: sha256=<hex(hmac)>,
-- X-Multica-Timestamp for replay windowing.
--
-- POC only — the trigger endpoint that writes this table is gated behind
-- MULTICA_ENABLE_POC_RUNS_API (off by default, never in production). The table
-- itself is harmless when the POC is disabled: nothing writes to it and the
-- subscriber no-ops on missing rows. See docs/agent-runs-as-a-service-rfc.md.
CREATE TABLE poc_run_callback (
    task_id UUID PRIMARY KEY REFERENCES agent_task_queue(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',   -- queued | delivered | failed
    attempt_count INT NOT NULL DEFAULT 0,
    last_response_status INT,
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);