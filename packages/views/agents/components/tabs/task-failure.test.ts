import { describe, expect, it } from "vitest";
import { failureReasonLabelFor } from "./task-failure";

// failureReasonLabelFor is the defensive boundary between the free-form
// back-end failure_reason string and the UI: it must return actionable copy
// for every canonical reason we emit today, and null for anything unknown so
// callers fall back to a generic status label instead of rendering undefined
// (API-Response-Compatibility: enum drift downgrades, not crashes).
describe("failureReasonLabelFor", () => {
  const known = [
    // Coarse platform-side reasons.
    "agent_error",
    "timeout",
    "codex_semantic_inactivity",
    "runtime_offline",
    "runtime_recovery",
    "manual",
    // Refined provider reasons emitted by taskfailure.Classify.
    "agent_error.provider_auth_or_access",
    "agent_error.provider_quota_limit",
    "agent_error.provider_capacity_or_rate_limit",
    "agent_error.provider_server_error",
    "agent_error.provider_network",
    "agent_error.missing_config",
    "agent_error.model_not_found_or_unavailable",
  ] as const;

  it.each(known)("returns non-empty copy for known reason %s", (reason) => {
    const label = failureReasonLabelFor(reason);
    expect(label).not.toBeNull();
    expect(label!.trim().length).toBeGreaterThan(0);
  });

  it("returns actionable `codex login` guidance for the auth reason", () => {
    const label = failureReasonLabelFor("agent_error.provider_auth_or_access");
    expect(label).toMatch(/codex login/i);
  });

  it("returns quota/credits guidance for the quota reason", () => {
    const label = failureReasonLabelFor("agent_error.provider_quota_limit");
    expect(label).toMatch(/quota|credits/i);
  });

  it.each([
    null,
    undefined,
    "",
    "some_future_reason_we_have_not_seen",
    "agent_error.new_thing",
  ])("returns null for unknown/empty reason %p so callers fall back", (reason) => {
    expect(failureReasonLabelFor(reason)).toBeNull();
  });
});