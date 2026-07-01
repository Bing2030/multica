"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import {
  myInvitationListOptions,
  workspaceKeys,
  workspaceListOptions,
} from "@multica/core/workspace/queries";
import { paths } from "@multica/core/paths";
import type { Invitation } from "@multica/core/types";
import { useNavigation } from "../navigation";
import { DragStrip } from "../platform";
import { useT } from "../i18n";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Mail, Users } from "lucide-react";

/**
 * Batch invitation handling page.
 *
 * The user picks zero or more invitations to accept. "Submit" then:
 *   • zero selected → return to the default workspace
 *   • ≥1 selected → accept each, refresh, navigate into the first accepted
 *     workspace.
 * Unselected invitations are intentionally left as `pending` in the DB. The
 * user can later decline them from the sidebar; we don't auto-decline here
 * because closing/refreshing this page should not be a destructive action.
 *
 * THROWAWAY POC: under DevBypass there is no onboarding hand-off (the dev user
 * is already provisioned into a workspace) and no "log out" affordance (the
 * next request re-stamps the same dev user). NEVER MERGE.
 */
export function InvitationsPage() {
  const { t } = useT("invite");
  const { push } = useNavigation();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    data: invitations,
    isLoading,
    error: fetchError,
    refetch,
  } = useQuery(myInvitationListOptions());

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    setError(null);

    // Zero selected: return to the default workspace. Pending invites stay
    // pending and can be picked up later from the sidebar.
    if (selected.size === 0) {
      push(paths.root());
      return;
    }

    setSubmitting(true);
    const acceptedIds: string[] = [];
    try {
      for (const id of selected) {
        await api.acceptInvitation(id);
        acceptedIds.push(id);
      }

      const firstAcceptedInvite = invitations?.find(
        (inv) => inv.id === acceptedIds[0],
      );

      // Refresh the user so any membership-derived state is current.
      await useAuthStore.getState().refreshMe();

      qc.invalidateQueries({ queryKey: workspaceKeys.myInvitations() });
      const wsList = await qc.fetchQuery({
        ...workspaceListOptions(),
        staleTime: 0,
      });

      const targetWs = firstAcceptedInvite
        ? wsList.find((w) => w.id === firstAcceptedInvite.workspace_id)
        : undefined;

      // If we can't resolve the just-accepted workspace by id (shouldn't
      // happen — the backend just inserted the membership and we just
      // refetched), fall back to creating a new workspace. Don't blindly route
      // to wsList[0]: that could teleport the user into an unrelated old
      // workspace they happen to also belong to.
      push(
        targetWs ? paths.workspace(targetWs.slug).issues() : paths.newWorkspace(),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t(($) => $.batch.error_generic),
      );
      // Partial success: any accepts that landed before the failure already
      // created the membership on the backend. Refresh local user + workspace
      // state so the sidebar reflects the partial accept.
      if (acceptedIds.length > 0) {
        await useAuthStore.getState().refreshMe().catch(() => {});
        qc.invalidateQueries({ queryKey: workspaceKeys.list() });
      }
      qc.invalidateQueries({ queryKey: workspaceKeys.myInvitations() });
      refetch();
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <InvitationsShell>
        <Card className="w-full max-w-lg">
          <CardContent className="flex flex-col gap-4 py-12">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </CardContent>
        </Card>
      </InvitationsShell>
    );
  }

  // Empty / error: return the user to the default workspace so they're never
  // stuck. Genuine fetch failure is rare; treating it as "no invites" is safer
  // than trapping the user on an error screen they can't act on.
  if (fetchError || !invitations || invitations.length === 0) {
    return (
      <InvitationsShell>
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Mail className="h-6 w-6 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold">{t(($) => $.batch.empty_title)}</h2>
            <p className="text-sm text-muted-foreground text-center">
              {t(($) => $.batch.empty_hint)}
            </p>
            <Button onClick={() => push(paths.root())}>
              {t(($) => $.batch.empty_continue)}
            </Button>
          </CardContent>
        </Card>
      </InvitationsShell>
    );
  }

  const submitLabel =
    selected.size === 0
      ? t(($) => $.batch.submit_skip)
      : t(($) => $.batch.submit_join, { count: selected.size });

  return (
    <InvitationsShell>
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col gap-6 py-10">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Users className="h-6 w-6 text-primary" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl font-semibold">
                {t(($) => $.batch.title)}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t(($) => $.batch.subtitle)}
              </p>
            </div>
          </div>

          <ul className="flex flex-col gap-2">
            {invitations.map((inv) => (
              <InvitationRow
                key={inv.id}
                invitation={inv}
                checked={selected.has(inv.id)}
                onToggle={() => toggle(inv.id)}
              />
            ))}
          </ul>

          <Button
            className="w-full"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? t(($) => $.batch.joining) : submitLabel}
          </Button>

          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}
        </CardContent>
      </Card>
    </InvitationsShell>
  );
}

function InvitationRow({
  invitation,
  checked,
  onToggle,
}: {
  invitation: Invitation;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t } = useT("invite");
  const inviter =
    invitation.inviter_name ||
    invitation.inviter_email ||
    t(($) => $.batch.row_inviter_fallback);
  const roleLine =
    invitation.role === "admin"
      ? t(($) => $.batch.row_invited_admin, { inviter })
      : t(($) => $.batch.row_invited_member, { inviter });
  return (
    <li>
      <label
        className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-4 hover:bg-accent/40"
      >
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          className="mt-1"
        />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="font-medium truncate">
            {invitation.workspace_name ?? t(($) => $.batch.row_workspace_fallback)}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {roleLine}
          </div>
        </div>
      </label>
    </li>
  );
}

function InvitationsShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-svh flex-col bg-background">
      <DragStrip />
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-12">
        {children}
      </div>
    </div>
  );
}