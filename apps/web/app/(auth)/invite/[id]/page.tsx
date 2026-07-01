"use client";

import { useRouter, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { paths } from "@multica/core/paths";
import { workspaceListOptions } from "@multica/core/workspace/queries";
import { InvitePage } from "@multica/views/invite";

// THROWAWAY POC: DevBypass stamps a fixed dev user on every request, so a
// session always exists — there is no login redirect. We only wait for the
// auth initializer to resolve before rendering. NEVER MERGE.
export default function InviteAcceptPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const isLoading = useAuthStore((s) => s.isLoading);
  const { data: wsList = [] } = useQuery(workspaceListOptions());

  if (isLoading) return null;

  const onBack =
    wsList.length > 0 ? () => router.push(paths.root()) : undefined;

  return <InvitePage invitationId={params.id} onBack={onBack} />;
}