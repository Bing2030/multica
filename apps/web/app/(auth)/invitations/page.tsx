"use client";

import { useAuthStore } from "@multica/core/auth";
import { InvitationsPage } from "@multica/views/invitations";

// THROWAWAY POC: DevBypass stamps a fixed dev user on every request, so a
// session always exists — there is no login redirect. We only wait for the
// auth initializer to resolve before rendering. NEVER MERGE.
export default function InvitationsRoutePage() {
  const isLoading = useAuthStore((s) => s.isLoading);
  if (isLoading) return null;
  return <InvitationsPage />;
}