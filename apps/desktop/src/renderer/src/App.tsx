import { useEffect, useLayoutEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CoreProvider } from "@multica/core/platform";
import { useAuthStore } from "@multica/core/auth";
import { workspaceListOptions } from "@multica/core/workspace/queries";
import { setCurrentWorkspace } from "@multica/core/platform";
import { ThemeProvider } from "@multica/ui/components/common/theme-provider";
import { MulticaIcon } from "@multica/ui/components/common/multica-icon";
import { Toaster } from "@multica/ui/components/ui/sonner";
import { DesktopShell } from "./components/desktop-layout";
import { PageviewTracker } from "./components/pageview-tracker";
import { UpdateNotification } from "./components/update-notification";
import { useTabStore } from "./stores/tab-store";
import { useWindowOverlayStore } from "./stores/window-overlay-store";
import { useDaemonIPCBridge } from "./platform/daemon-ipc-bridge";
import { captureEvent } from "@multica/core/analytics";
import { RESOURCES } from "@multica/views/locales";


/**
 * Cmd/Ctrl+W: close the active tab. When the last real tab is closed
 * (or no tabs/workspace exist), close the window.
 *
 * Mounted at the App root so every renderer state — including loading and
 * runtime-config errors — has a working Cmd+W handler. Without this, states
 * outside the tab shell would swallow the shortcut and do nothing.
 */
function useCmdWCloseTab() {
  useEffect(() => {
    return window.desktopAPI.onCloseActiveTab(() => {
      const store = useTabStore.getState();
      const { activeWorkspaceSlug, byWorkspace } = store;
      if (!activeWorkspaceSlug) {
        // No workspace — nothing to close, dismiss the window.
        window.desktopAPI.closeWindow();
        return;
      }
      const group = byWorkspace[activeWorkspaceSlug];
      if (!group || group.tabs.length <= 1) {
        // Last tab (or no tabs) — close the window.
        window.desktopAPI.closeWindow();
        return;
      }
      // Multiple tabs — close the active one.
      store.closeActiveTab();
    });
  }, []);
}

function AppContent() {
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);

  const runtimeConfig = window.desktopAPI.runtimeConfig.ok
    ? window.desktopAPI.runtimeConfig.config
    : null;

  // Tell the main process which backend URL we talk to, so daemon-manager
  // can pick the matching CLI profile (server_url from ~/.multica config).
  useEffect(() => {
    if (!runtimeConfig) return;
    window.daemonAPI.setTargetApiUrl(runtimeConfig.apiUrl);
  }, [runtimeConfig]);

  // Listen for invite IDs delivered via deep link (multica://invite/<id>).
  useEffect(() => {
    return window.desktopAPI.onInviteOpen((invitationId) => {
      useWindowOverlayStore.getState().open({ type: "invite", invitationId });
    });
  }, []);

  // Start the daemon when the user resolves. THROWAWAY POC: DevBypass stamps
  // the dev user on every request, so there is no token to sync — the daemon
  // registers with no credential and the server authorizes it via X-User-ID.
  // NEVER MERGE.
  useEffect(() => {
    if (!user) return;
    window.daemonAPI.autoStart().catch((err) => {
      console.error("Failed to start daemon", err);
    });
  }, [user]);

  const { data: workspaces = [], isFetched: workspaceListFetched } = useQuery({
    ...workspaceListOptions(),
    enabled: !!user,
  });
  const wsCount = workspaces.length;

  // Bridge local daemon IPC status into the runtimes cache so this user's
  // own daemon flips to offline/online sub-second instead of waiting on the
  // server's 75s sweeper. Resolves wsId from the active tab so workspace
  // switches automatically rebind the subscription.
  const activeWorkspaceSlug = useTabStore((s) => s.activeWorkspaceSlug);
  const activeWsId = activeWorkspaceSlug
    ? workspaces.find((w) => w.slug === activeWorkspaceSlug)?.id
    : undefined;
  useDaemonIPCBridge(activeWsId);

  // Pre-workspace overlay routing for desktop. THROWAWAY POC: under DevBypass
  // the dev user is always onboarded and provisioned into the multica-dev
  // workspace, so the only remaining transition is "no workspaces at all" →
  // open the create-workspace overlay. Onboarding/login overlays are gone.
  // NEVER MERGE.
  useEffect(() => {
    if (!user || !workspaceListFetched) return undefined;
    const { overlay, open } = useWindowOverlayStore.getState();
    if (overlay) return undefined;
    if (wsCount === 0) {
      setCurrentWorkspace(null, null);
      open({ type: "new-workspace" });
    }
    return undefined;
  }, [user, workspaceListFetched, wsCount]);


  // Validate persisted tab state against the current user's workspace list,
  // and pick an active workspace if none is set. Runs in useLayoutEffect
  // (synchronously after render, before paint) rather than the render
  // phase — the original render-phase pattern triggered React's
  // "Cannot update a component while rendering a different component"
  // warning because `switchWorkspace` is a Zustand setState that the TabBar
  // is subscribed to. useLayoutEffect flushes both renders before the
  // user sees anything, so there's no visible flicker.
  //
  // Gate on `workspaceListFetched`: useQuery defaults `data` to `[]` before
  // the first fetch, so without this guard we'd run validation against an
  // empty slug set, wipe the persisted `activeWorkspaceSlug`, then fall
  // back to `workspaces[0]` once the real list arrives — losing the user's
  // last-opened workspace on every app start.
  useLayoutEffect(() => {
    if (!workspaceListFetched) return;
    const validSlugs = new Set(workspaces.map((w) => w.slug));
    useTabStore.getState().validateWorkspaceSlugs(validSlugs);
    const { activeWorkspaceSlug, switchWorkspace } = useTabStore.getState();
    if (!activeWorkspaceSlug && workspaces.length > 0) {
      switchWorkspace(workspaces[0].slug);
    }
  }, [workspaces, workspaceListFetched]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <MulticaIcon className="size-6 animate-pulse" />
      </div>
    );
  }

  // THROWAWAY POC: DevBypass guarantees a dev user, so we always render the
  // shell once init resolves. If getMe failed (e.g. backend down) we keep the
  // spinner up rather than white-screening. NEVER MERGE.
  return (
    <>
      <PageviewTracker />
      {user ? (
        <DesktopShell />
      ) : (
        <div className="flex h-screen items-center justify-center">
          <MulticaIcon className="size-6 animate-pulse" />
        </div>
      )}
    </>
  );
}

function BlockingRuntimeConfigError({ message }: { message: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-xl rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Desktop configuration error</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Multica Desktop could not load <code>~/.multica/desktop.json</code>. Fix or remove the file and restart the app.
        </p>
        <pre className="mt-4 whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-muted-foreground">
          {message}
        </pre>
      </div>
    </div>
  );
}

// THROWAWAY POC: under DevBypass there is no real logout (the next request
// re-stamps the dev user), but this hook still fires on auth-init failure.
// We reset desktop-only in-memory state and stop the daemon so a backend
// reconnect starts clean. The daemon token surface is gone — the dummy token
// in config.json is reusable across sessions. NEVER MERGE.
async function handleDaemonLogout() {
  useTabStore.getState().reset();
  useWindowOverlayStore.getState().close();
  try {
    await window.daemonAPI.stop();
  } catch {
    // Daemon may already be stopped.
  }
}

export default function App() {
  const { version, os } = window.desktopAPI.appInfo;
  const runtimeConfigResult = window.desktopAPI.runtimeConfig;
  useCmdWCloseTab();

  // Flush a freeze/crash breadcrumb the main process parked from a previous
  // session. A true hang or process death can't report itself when it happens
  // (the renderer is blocked or gone), so the main process persists it and we
  // emit it here on the next boot. The in-thread, recoverable freeze tier is
  // handled separately by the shared watchdog in CoreProvider.
  useEffect(() => {
    const last = window.desktopAPI.getLastFreeze();
    if (!last) return;
    const crashed = last.kind === "render-process-gone";
    captureEvent(crashed ? "client_crash" : "client_unresponsive", {
      // Spread context FIRST so our explicit fields below always win — a
      // future context key (e.g. its own `source`) must not silently override.
      ...last.context,
      source: crashed ? "render-process-gone" : "main-unresponsive",
      recovered: false,
      breadcrumb_ts: last.ts,
      crashed_version: last.version,
    });
  }, []);

  // Stable identity reference so downstream effects (WS reconnect) don't
  // tear down on every parent render.
  const identity = useMemo(
    () => ({ platform: "desktop", version, os }),
    [version, os],
  );
  // English is the only supported locale.
  const locale = "en" as const;
  const resources = useMemo(
    () => ({ en: RESOURCES.en }),
    [],
  );

  return (
    <ThemeProvider>
      {runtimeConfigResult.ok ? (
        <CoreProvider
          apiBaseUrl={runtimeConfigResult.config.apiUrl}
          wsUrl={runtimeConfigResult.config.wsUrl}
          onLogout={handleDaemonLogout}
          identity={identity}
          locale={locale}
          resources={resources}
        >
          <AppContent />
        </CoreProvider>
      ) : (
        <BlockingRuntimeConfigError message={runtimeConfigResult.error.message} />
      )}
      <Toaster />
      <UpdateNotification />
    </ThemeProvider>
  );
}