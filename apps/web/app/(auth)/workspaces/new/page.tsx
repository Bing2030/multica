"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { paths } from "@multica/core/paths";
import { workspaceListOptions } from "@multica/core/workspace/queries";
import { NewWorkspacePage } from "@multica/views/workspace/new-workspace-page";

// THROWAWAY POC: DevBypass stamps a fixed dev user on every request, so a
// session always exists — there is no login redirect. We only wait for the
// auth initializer to resolve before rendering. NEVER MERGE.
export default function Page() {
  const router = useRouter();
  const isLoading = useAuthStore((s) => s.isLoading);
  const { data: wsList = [] } = useQuery(workspaceListOptions());

  if (isLoading) return null;

  // Back goes to the root path — the workspace layout redirects from
  // there to the user's default workspace. Only show Back when there's
  // somewhere to go back to (user already has at least one workspace).
  const onBack =
    wsList.length > 0 ? () => router.push(paths.root()) : undefined;

  return (
    <NewWorkspacePage
      onSuccess={(ws) => router.push(paths.workspace(ws.slug).issues())}
      onBack={onBack}
    />
  );
}