"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { resolvePostAuthDestination } from "@multica/core/paths";
import { workspaceListOptions } from "@multica/core/workspace/queries";
import { useAuthStore } from "@multica/core/auth";
import { MulticaIcon } from "@multica/ui/components/common/multica-icon";

// THROWAWAY POC: DevBypass stamps a fixed dev user on every request, so `/`
// is never a marketing stop — it resolves straight into the dev workspace
// dashboard, matching desktop. NEVER MERGE.
export default function LandingPage() {
  const router = useRouter();
  const isLoading = useAuthStore((s) => s.isLoading);
  const { data: wsList = [] } = useQuery(workspaceListOptions());

  useEffect(() => {
    if (isLoading) return;
    router.replace(resolvePostAuthDestination(wsList));
  }, [isLoading, wsList, router]);

  return (
    <div className="flex h-svh items-center justify-center">
      <MulticaIcon className="size-6 animate-pulse" />
    </div>
  );
}