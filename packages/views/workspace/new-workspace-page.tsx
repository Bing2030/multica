"use client";

import { ArrowLeft } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import type { Workspace } from "@multica/core/types";
import { useConfigStore } from "@multica/core/config";
import { DragStrip } from "../platform";
import { useT } from "../i18n";
import { CreateWorkspaceForm } from "./create-workspace-form";

/**
 * Full-page shell for the "create workspace" transition. Shared between web
 * (Next.js route `/workspaces/new`) and desktop (window-overlay). The top-bar
 * Back affordance (when dismissable) lives here so both platforms get
 * identical UX; platform-specific concerns like window-drag region and macOS
 * traffic-light handling stay in each app's shell.
 *
 * `onBack` is optional: caller passes it only when there's somewhere to go
 * back to (user has other workspaces, or the flow was entered from an existing
 * session). On the zero-workspace entry path it's omitted, which hides Back.
 *
 * THROWAWAY POC: under DevBypass there is no "log out" affordance — the next
 * request re-stamps the same dev user, so the button was a no-op. NEVER MERGE.
 */
export function NewWorkspacePage({
  onSuccess,
  onBack,
}: {
  onSuccess: (workspace: Workspace) => void;
  onBack?: () => void;
}) {
  const { t } = useT("workspace");
  const workspaceCreationDisabled = useConfigStore((s) => s.workspaceCreationDisabled);

  return (
    <div className="relative flex min-h-svh flex-col bg-background">
      <DragStrip />
      {onBack && (
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-16 left-12 text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft />
          {t(($) => $.new_page.back)}
        </Button>
      )}

      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-12">
        <div className="flex w-full max-w-md flex-col items-center gap-6">
          {workspaceCreationDisabled ? (
            <div className="text-center">
              <h1 className="text-3xl font-semibold tracking-tight">
                {t(($) => $.creation_disabled.title)}
              </h1>
              <p className="mt-3 text-muted-foreground">
                {t(($) => $.creation_disabled.description)}
              </p>
            </div>
          ) : (
            <>
              <div className="text-center">
                <h1 className="text-3xl font-semibold tracking-tight">
                  {t(($) => $.new_page.title)}
                </h1>
                <p className="mt-3 text-muted-foreground">
                  {t(($) => $.new_page.description)}
                </p>
              </div>
              <CreateWorkspaceForm onSuccess={onSuccess} />
              <p className="text-center text-xs text-muted-foreground">
                {t(($) => $.new_page.invite_hint)}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}