/**
 * Re-establish the local daemon's credentials after it failed to authenticate.
 *
 * THROWAWAY POC: under DevBypass the daemon runs with no PAT — the server
 * authorizes it via the X-User-ID stamped on every request, so there is no
 * token to mint, revoke, or re-establish and no "auth_expired" state to
 * recover from. This is a no-op kept only so the runtime-card / settings-tab
 * call sites stay compilable until the daemon-token machinery is fully
 * removed in Phase 4. NEVER MERGE.
 */
export async function reauthenticateDaemon(): Promise<void> {
  return;
}