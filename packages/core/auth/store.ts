import { create } from "zustand";
import type { User, StorageAdapter } from "../types";
import { identify as identifyAnalytics } from "../analytics";
import type { ApiClient } from "../api/client";
import { setCurrentWorkspace } from "../platform/workspace-storage";

export interface AuthStoreOptions {
  api: ApiClient;
  storage: StorageAdapter;
  onLogin?: () => void;
  onLogout?: () => void;
  /**
   * Retained for API symmetry with the platform factory. Auth no longer has a
   * token/cookie mode — DevBypass stamps a fixed dev user on every request —
   * so this flag no longer changes behavior.
   */
  cookieAuth?: boolean;
}

export interface AuthState {
  user: User | null;
  isLoading: boolean;

  initialize: () => Promise<void>;
  setUser: (user: User) => void;
  refreshMe: () => Promise<void>;
}

export function createAuthStore(options: AuthStoreOptions) {
  const { api, onLogin } = options;

  return create<AuthState>((set) => ({
    user: null,
    isLoading: true,

    // THROWAWAY POC: backend auth is disabled — every request runs as a
    // fixed dev user (server/internal/middleware/dev_bypass.go), so a session
    // always exists. Fetch it directly; there is no token to attach and no
    // login/logout flow. NEVER MERGE.
    initialize: async () => {
      try {
        const user = await api.getMe();
        onLogin?.();
        identifyAnalytics(user.id, { email: user.email, name: user.name });
        set({ user, isLoading: false });
      } catch {
        setCurrentWorkspace(null, null);
        set({ user: null, isLoading: false });
      }
    },

    setUser: (user: User) => {
      set({ user });
    },

    refreshMe: async () => {
      const user = await api.getMe();
      set({ user });
    },
  }));
}