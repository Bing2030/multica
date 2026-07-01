/**
 * TestApiClient — lightweight API helper for E2E test data setup/teardown.
 *
 * Uses raw fetch so E2E tests have zero build-time coupling to the web app.
 *
 * THROWAWAY POC: the backend runs under DevBypass, which stamps a single
 * canonical dev user (DEV_BYPASS_EMAIL) on every request regardless of any
 * Authorization header. So there is no login flow here — `login` is a no-op
 * retained only for call-site compatibility, `authedFetch` sends no token, and
 * `getEmail()` returns the dev user (the actual actor). E2E specs collapse onto
 * that shared dev user. NEVER MERGE.
 */

import "./env";

// `||` (not `??`) so an empty `NEXT_PUBLIC_API_URL=` in .env still falls
// back to localhost. dotenv sets unset-vs-empty both as "" — treating them
// the same matches user intent.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  `http://localhost:${process.env.PORT || "8080"}`;

// Must match middleware.DevBypassEmail on the server (dev@multica.local).
// The fixed actor DevBypass stamps on every request — tests that look up
// "the e2e user" resolve to this row.
const DEV_BYPASS_EMAIL = "dev@multica.local";

interface TestWorkspace {
  id: string;
  name: string;
  slug: string;
}

export class TestApiClient {
  private workspaceSlug: string | null = null;
  private workspaceId: string | null = null;
  private createdIssueIds: string[] = [];

  /**
   * No-op under DevBypass: the server stamps the dev user on every request
   * regardless of credentials. Kept only so existing call sites compile; the
   * email/name arguments are intentionally ignored (the actor is fixed).
   */
  async login(_email: string, _name: string) {
    // Intentionally empty — see class doc.
  }

  async getWorkspaces(): Promise<TestWorkspace[]> {
    const res = await this.authedFetch("/api/workspaces");
    return res.json();
  }

  setWorkspaceId(id: string) {
    this.workspaceId = id;
  }

  setWorkspaceSlug(slug: string) {
    this.workspaceSlug = slug;
  }

  async ensureWorkspace(name = "E2E Workspace", slug = "e2e-workspace") {
    const workspaces = await this.getWorkspaces();
    const workspace = workspaces.find((item) => item.slug === slug) ?? workspaces[0];
    if (workspace) {
      this.workspaceId = workspace.id;
      this.workspaceSlug = workspace.slug;
      return workspace;
    }

    const res = await this.authedFetch("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    });
    if (res.ok) {
      const created = (await res.json()) as TestWorkspace;
      this.workspaceId = created.id;
      this.workspaceSlug = created.slug;
      return created;
    }

    const refreshed = await this.getWorkspaces();
    const created = refreshed.find((item) => item.slug === slug) ?? refreshed[0];
    if (created) {
      this.workspaceId = created.id;
      this.workspaceSlug = created.slug;
      return created;
    }

    throw new Error(`Failed to ensure workspace ${slug}: ${res.status} ${res.statusText}`);
  }

  async createIssue(title: string, opts?: Record<string, unknown>) {
    const res = await this.authedFetch("/api/issues", {
      method: "POST",
      body: JSON.stringify({ title, ...opts }),
    });
    const issue = await res.json();
    this.createdIssueIds.push(issue.id);
    return issue;
  }

  async deleteIssue(id: string) {
    await this.authedFetch(`/api/issues/${id}`, { method: "DELETE" });
  }

  /** Clean up all issues created during this test. */
  async cleanup() {
    for (const id of this.createdIssueIds) {
      try {
        await this.deleteIssue(id);
      } catch {
        /* ignore — may already be deleted */
      }
    }
    this.createdIssueIds = [];
  }

  /**
   * The dev user DevBypass stamps as the actor. Throws if not "logged in",
   * which under DevBypass is always — but the guard keeps the pre-POC contract
   * for callers that assert a user exists.
   */
  getEmail() {
    return DEV_BYPASS_EMAIL;
  }

  /**
   * Workspace-scoped fetch with no Authorization header (DevBypass stamps the
   * dev user). Public so specs that hit endpoints directly (e.g. file upload)
   * share the same workspace-header wiring as the helper methods.
   */
  async authedFetch(path: string, init?: RequestInit) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    // No Authorization header: DevBypass ignores credentials and stamps the
    // dev user from the request alone.
    if (this.workspaceSlug) headers["X-Workspace-Slug"] = this.workspaceSlug;
    else if (this.workspaceId) headers["X-Workspace-ID"] = this.workspaceId;
    return fetch(`${API_BASE}${path}`, { ...init, headers });
  }
}
