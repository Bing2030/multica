import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { configStore } from "@multica/core/config";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { ConnectRemoteDialog } from "./connect-remote-dialog";

const TEST_RESOURCES = { en: { common: enCommon, runtimes: enRuntimes } };

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-test",
}));

vi.mock("@multica/core/paths", () => ({
  paths: {
    workspace: () => ({
      agents: () => "/agents",
      runtimeDetail: () => "/runtimes/rt-test",
    }),
  },
  useWorkspaceSlug: () => "workspace-test",
}));

vi.mock("@multica/core/realtime", () => ({
  useWSEvent: vi.fn(),
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push: vi.fn() }),
}));

function resetConfigStore() {
  configStore.setState({
    cdnDomain: "",
    cdnSigned: false,
    allowSignup: true,
    googleClientId: "",
    daemonServerUrl: "",
    daemonAppUrl: "",
    workspaceCreationDisabled: false,
  });
}

function renderDialog(config?: {
  daemonServerUrl?: string;
  daemonAppUrl?: string;
}) {
  resetConfigStore();
  if (config) {
    configStore.getState().setDaemonConfig(config);
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ConnectRemoteDialog onClose={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const ligatureClasses = [
  "[font-variant-ligatures:none]",
  "[font-feature-settings:'liga'_0]",
];

describe("ConnectRemoteDialog", () => {
  it("shows cloud server URL by default", () => {
    const { baseElement } = renderDialog();

    expect(baseElement).toHaveTextContent("https://api.multica.ai");
    expect(baseElement).toHaveTextContent("https://multica.ai");
  });

  it("uses self-host daemon URLs from runtime config", () => {
    const { baseElement } = renderDialog({
      daemonServerUrl: "https://api.example.com/",
      daemonAppUrl: "https://app.example.com/",
    });

    expect(baseElement).toHaveTextContent("https://api.example.com");
    expect(baseElement).toHaveTextContent("https://app.example.com");
  });

  it("shows multica daemon start as the only shell command", () => {
    const { baseElement } = renderDialog();

    expect(baseElement).toHaveTextContent("multica daemon start");
    // Removed commands must not appear
    expect(baseElement).not.toHaveTextContent("multica setup");
    expect(baseElement).not.toHaveTextContent("multica login");
    expect(baseElement).not.toHaveTextContent("multica config set");
    expect(baseElement).not.toHaveTextContent("install.sh");
  });

  it("generates config JSON with entered token", () => {
    const { baseElement } = renderDialog();

    const tokenInput = screen.getByPlaceholderText("mul_...");
    fireEvent.change(tokenInput, { target: { value: "mul_test_token" } });

    expect(baseElement).toHaveTextContent("mul_test_token");
    expect(baseElement).toHaveTextContent("server_url");
    expect(baseElement).toHaveTextContent("app_url");
  });

  it("disables font ligatures in daemon start command code", () => {
    const { baseElement } = renderDialog();

    const startCode = Array.from(baseElement.querySelectorAll("code")).find(
      (node) => node.textContent?.includes("multica daemon start"),
    );

    expect(startCode).toHaveClass(...ligatureClasses);
  });

  it("disables font ligatures in config JSON code", () => {
    const { baseElement } = renderDialog();

    const configCode = Array.from(baseElement.querySelectorAll("code")).find(
      (node) => node.textContent?.includes("server_url"),
    );

    expect(configCode).toHaveClass(...ligatureClasses);
  });
});
