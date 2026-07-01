import type { Workspace } from "../types";
import { paths } from "./paths";

/**
 * Picks where to send a user who has no valid workspace in the URL.
 *
 *   workspace[0] → /<first.slug>/issues
 *   no workspace → /workspaces/new
 *
 * The onboarding gate was removed for the local POC: DevBypass stamps a fixed
 * dev user and auto-provisions the dev workspace, so a session always exists and
 * there is no `onboarded_at` check. Callers that need invitation-aware routing
 * handle the pending-invites branch themselves before calling this resolver.
 */
export function resolvePostAuthDestination(workspaces: Workspace[]): string {
  const first = workspaces[0];
  if (first) {
    return paths.workspace(first.slug).issues();
  }
  return paths.newWorkspace();
}