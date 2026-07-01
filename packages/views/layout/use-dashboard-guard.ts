"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigationStore } from "@multica/core/navigation";
import { useAuthStore } from "@multica/core/auth";
import { resolvePostAuthDestination, useCurrentWorkspace } from "@multica/core/paths";
import { workspaceListOptions } from "@multica/core/workspace";
import { useRecentIssuesStore } from "@multica/core/issues/stores";
import { useNavigation } from "../navigation";

/**
 * Workspace gate for the dashboard.
 *
 * THROWAWAY POC: DevBypass stamps a fixed dev user on every request, so a
 * session always exists — there is no login redirect. The guard only handles
 * workspace presence: wait for the auth initializer + workspace list, then if
 * the URL slug doesn't resolve, land in the first workspace (the dev workspace
 * is always provisioned). NEVER MERGE.
 *
 * Redirect logic:
 *  - Auth still loading → wait
 *  - Workspace list not yet loaded → wait (don't bounce prematurely)
 *  - URL slug doesn't resolve to any workspace →
 *    `resolvePostAuthDestination(list)` (lands in `<first.slug>/issues`)
 *
 * We read the workspace list query state directly (rather than relying on
 * useCurrentWorkspace's null return) so we can distinguish "list loading"
 * from "slug not found". Otherwise users could see a transient redirect
 * before their workspace list arrives.
 */
export function useDashboardGuard() {
  const { pathname, replace } = useNavigation();
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const workspace = useCurrentWorkspace();
  const { data: workspaces = [], isFetched: workspaceListFetched } = useQuery({
    ...workspaceListOptions(),
    enabled: !!user,
  });

  useEffect(() => {
    if (isLoading) return;
    if (!user) return;
    if (!workspaceListFetched) return;
    if (!workspace) {
      replace(resolvePostAuthDestination(workspaces));
    }
  }, [user, isLoading, workspaceListFetched, workspace, workspaces, replace]);

  useEffect(() => {
    useNavigationStore.getState().onPathChange(pathname);
  }, [pathname]);

  // Drop recent-issues buckets for workspaces the user no longer belongs to.
  // Runs once the workspace list resolves, and again whenever membership
  // changes (workspace deleted, user kicked, user left).
  useEffect(() => {
    if (!workspaceListFetched) return;
    useRecentIssuesStore
      .getState()
      .pruneWorkspaces(workspaces.map((w) => w.id));
  }, [workspaceListFetched, workspaces]);

  return { user, isLoading, workspace };
}