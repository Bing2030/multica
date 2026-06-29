// Human-readable, actionable copy for the back-end task failure_reason enum.
// Surfaced in the agent detail Recent Work tab, the issue execution log, and
// the chat message list when a task ended in failure — the only places the
// front-end exposes failure_reason directly to the user.
//
// `failureReasonLabelFor` is defensive: it accepts the raw back-end string
// (any of the canonical agent_error.* refined reasons, a coarse platform
// reason, or an unknown future value) and returns null for anything not in
// the map, so callers fall back to a generic status label rather than render
// undefined. This keeps the UI resilient to enum drift per the project's
// API-Response-Compatibility rules (enum drift downgrades, not crashes; no
// bare `as` casts on response data).
const failureReasonLabels: Record<string, string> = {
  // Coarse platform-side reasons.
  agent_error: "Agent execution error",
  timeout: "Task timed out",
  codex_semantic_inactivity: "Codex stalled with no progress",
  runtime_offline: "Daemon offline",
  runtime_recovery: "Daemon restarted",
  manual: "Cancelled by user",

  // Refined provider reasons emitted by taskfailure.Classify. These carry
  // actionable copy so the user knows what to fix instead of staring at a
  // generic "agent error".
  "agent_error.provider_auth_or_access":
    "Agent provider rejected the request — not logged in or no access. Run `codex login` on the runtime host (or set the provider API key), then rerun.",
  "agent_error.provider_quota_limit":
    "Agent provider quota or credits exhausted. Top up the account or switch the agent's model, then rerun.",
  "agent_error.provider_capacity_or_rate_limit":
    "Agent provider is rate-limited or overloaded. Wait a moment and rerun.",
  "agent_error.provider_server_error":
    "Agent provider had a server error. Retry shortly.",
  "agent_error.provider_network": "Agent provider network error. Retry shortly.",
  "agent_error.missing_config":
    "Agent is missing required config (API key / login). Fix the runtime's agent settings and rerun.",
  "agent_error.model_not_found_or_unavailable":
    "The agent's configured model is unavailable. Switch the model and rerun.",
};

// failureReasonLabelFor returns actionable copy for a failure_reason, or null
// when the reason is unknown/empty so the caller can fall back to a generic
// status label.
export function failureReasonLabelFor(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  return failureReasonLabels[reason] ?? null;
}
