// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Agent, RuntimeDevice } from "@multica/core/types";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../../locales/en/common.json";
import enAgents from "../../../locales/en/agents.json";
import { SettingsTab, providerSupportsSettingsPath } from "./settings-tab";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const baseAgent: Agent = {
  id: "agent-1",
  workspace_id: "ws-1",
  runtime_id: "runtime-1",
  name: "Agent",
  description: "",
  instructions: "",
  avatar_url: null,
  runtime_mode: "local",
  runtime_config: {},
  custom_args: [],
  visibility: "workspace",
  status: "idle",
  max_concurrent_tasks: 1,
  model: "",
  owner_id: "user-1",
  skills: [],
  created_at: "2026-05-28T00:00:00Z",
  updated_at: "2026-05-28T00:00:00Z",
  archived_at: null,
  archived_by: null,
};

const localClaudeRuntime: RuntimeDevice = {
  id: "runtime-1",
  workspace_id: "ws-1",
  daemon_id: "daemon-1",
  name: "Claude Local",
  runtime_mode: "local",
  provider: "claude",
  launch_header: "claude --output-format stream-json",
  status: "online",
  device_info: "",
  metadata: {},
  owner_id: "user-1",
  visibility: "private",
  last_seen_at: "2026-05-28T00:00:00Z",
  created_at: "2026-05-28T00:00:00Z",
  updated_at: "2026-05-28T00:00:00Z",
};

const localOpencodeRuntime: RuntimeDevice = {
  ...localClaudeRuntime,
  id: "runtime-2",
  name: "OpenCode Local",
  provider: "opencode",
  launch_header: "opencode run",
};

function renderTab(
  agentOverrides: Partial<Agent> = {},
  runtimeDevice?: RuntimeDevice,
  onSave = vi.fn().mockResolvedValue(undefined),
) {
  const agent = { ...baseAgent, ...agentOverrides };
  const result = render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <SettingsTab
        agent={agent}
        runtimeDevice={runtimeDevice}
        onSave={onSave}
      />
    </I18nProvider>,
  );
  return { ...result, onSave };
}

describe("providerSupportsSettingsPath", () => {
  it("returns true for claude provider", () => {
    expect(providerSupportsSettingsPath("claude")).toBe(true);
  });

  it("returns true for opencode provider", () => {
    expect(providerSupportsSettingsPath("opencode")).toBe(true);
  });

  it("returns false for other providers", () => {
    expect(providerSupportsSettingsPath("codex")).toBe(false);
    expect(providerSupportsSettingsPath("cursor")).toBe(false);
    expect(providerSupportsSettingsPath("unknown")).toBe(false);
  });

  it("returns false for undefined/null", () => {
    expect(providerSupportsSettingsPath(undefined)).toBe(false);
    expect(providerSupportsSettingsPath(null)).toBe(false);
  });
});

describe("SettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the editor with the existing settings_path for claude runtime", () => {
    renderTab(
      { settings_path: "/home/user/.claude/settings-work.json" },
      localClaudeRuntime,
    );

    const input = screen.getByPlaceholderText(
      /home\/user\/\.claude/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("/home/user/.claude/settings-work.json");
  });

  it("shows the editor empty when no settings_path is set", () => {
    renderTab({}, localOpencodeRuntime);

    const input = screen.getByPlaceholderText(
      /home\/user\/\.claude/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("");

    // Save is disabled when there are no changes
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("saves a non-empty path on save", async () => {
    const user = userEvent.setup();
    const { onSave } = renderTab({}, localClaudeRuntime);

    const input = screen.getByPlaceholderText(
      /home\/user\/\.claude/i,
    ) as HTMLInputElement;
    await user.type(input, "/home/user/.claude/settings-custom.json");

    const save = screen.getByRole("button", { name: /save/i });
    expect(save).toBeEnabled();
    await user.click(save);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      settings_path: "/home/user/.claude/settings-custom.json",
    });
  });

  it("clears the path when submitting empty string", async () => {
    const user = userEvent.setup();
    const { onSave } = renderTab(
      { settings_path: "/old/path.json" },
      localOpencodeRuntime,
    );

    const input = screen.getByPlaceholderText(
      /home\/user\/\.claude/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("/old/path.json");

    await user.clear(input);

    const save = screen.getByRole("button", { name: /save/i });
    await user.click(save);

    // Empty string clears the column on the backend
    expect(onSave).toHaveBeenCalledWith({ settings_path: "" });
  });

  it("sends the path as-is (backend handles trimming)", async () => {
    const user = userEvent.setup();
    const { onSave } = renderTab({}, localClaudeRuntime);

    const input = screen.getByPlaceholderText(
      /home\/user\/\.claude/i,
    ) as HTMLInputElement;
    await user.type(input, "  /path/to/settings.json  ");

    const save = screen.getByRole("button", { name: /save/i });
    await user.click(save);

    // Frontend sends the raw value; backend trims before persisting
    expect(onSave).toHaveBeenCalledWith({
      settings_path: "  /path/to/settings.json  ",
    });
  });

  it("shows the Clear button when a path is set", () => {
    renderTab({ settings_path: "/existing/path.json" }, localClaudeRuntime);

    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
  });

  it("hides the Clear button when no path is set", () => {
    renderTab({}, localClaudeRuntime);

    expect(screen.queryByRole("button", { name: /clear/i })).not.toBeInTheDocument();
  });

  it("Clear button empties the input without saving immediately", async () => {
    const user = userEvent.setup();
    const { onSave } = renderTab(
      { settings_path: "/existing/path.json" },
      localOpencodeRuntime,
    );

    const input = screen.getByPlaceholderText(
      /home\/user\/\.claude/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("/existing/path.json");

    const clearBtn = screen.getByRole("button", { name: /clear/i });
    await user.click(clearBtn);

    expect(input.value).toBe("");
    // Save is enabled because the field changed from non-empty to empty
    expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
    // onSave not called yet — user still needs to click Save
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows provider-specific launch hint for Claude", () => {
    renderTab({}, localClaudeRuntime);

    expect(screen.getByText(/Claude applies this as --settings/i)).toBeInTheDocument();
  });

  it("shows provider-specific launch hint for OpenCode", () => {
    renderTab({}, localOpencodeRuntime);

    expect(
      screen.getByText(/OpenCode applies this via OPENCODE_CONFIG/i),
    ).toBeInTheDocument();
  });

  it("shows unsaved changes hint when the field is dirty", async () => {
    const user = userEvent.setup();
    renderTab({}, localClaudeRuntime);

    const input = screen.getByPlaceholderText(
      /home\/user\/\.claude/i,
    ) as HTMLInputElement;
    await user.type(input, "/new/path.json");

    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
  });
});