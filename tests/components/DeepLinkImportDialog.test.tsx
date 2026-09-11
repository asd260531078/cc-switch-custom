import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { deeplinkApi } from "@/lib/api/deeplink";
import { emitTauriEvent } from "../msw/tauriMocks";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

describe("DeepLinkImportDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const desktopRequest = {
    version: "v1",
    resource: "provider" as const,
    app: "claude-desktop" as const,
    name: "Desktop Relay",
    homepage: "https://example.com",
    endpoint: "https://api.example.com",
    apiKey: "sk-provider-key",
    model: "claude-sonnet-4-5",
    haikuModel: "claude-haiku-4-5",
    sonnetModel: "claude-sonnet-4-5",
    opusModel: "claude-opus-4-5",
  };

  it("shows Claude Desktop models and masks its Claude env config", async () => {
    const config = btoa(
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: "desktop-config-secret",
          NODE_OPTIONS: "--require ./untrusted.js",
        },
      }),
    );
    vi.spyOn(deeplinkApi, "mergeDeeplinkConfig").mockResolvedValue({
      ...desktopRequest,
      config,
    });

    render(<DeepLinkImportDialog />, { wrapper: Wrapper });
    act(() => {
      emitTauriEvent("deeplink-import", { ...desktopRequest, config });
    });

    await screen.findByText("deeplink.defaultModel");
    expect(screen.getByText("claude-haiku-4-5")).toBeInTheDocument();
    expect(screen.getAllByText("claude-sonnet-4-5")).toHaveLength(2);
    expect(screen.getByText("claude-opus-4-5")).toBeInTheDocument();
    expect(screen.getByText("desk************")).toBeInTheDocument();
    expect(screen.queryByText("desktop-config-secret")).not.toBeInTheDocument();
    expect(screen.getByText(/NODE_OPTIONS/)).toBeInTheDocument();
  });

  it("imports Claude Desktop disabled even when the link requests enabled", async () => {
    const importSpy = vi
      .spyOn(deeplinkApi, "importFromDeeplink")
      .mockResolvedValue({ type: "provider", id: "desktop-id" });
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      emitTauriEvent("deeplink-import", { ...desktopRequest, enabled: true });
    });
    await screen.findByRole("button", { name: "deeplink.importOnly" });
    fireEvent.click(
      screen.getByRole("button", { name: "deeplink.importOnly" }),
    );

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith(
        expect.objectContaining({ app: "claude-desktop", enabled: false }),
      );
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["providers", "claude-desktop"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["claudeDesktopStatus"],
    });
  });

  it("switches Claude Desktop only through the explicit action and refreshes legacy results", async () => {
    const importSpy = vi
      .spyOn(deeplinkApi, "importFromDeeplink")
      .mockResolvedValue("desktop-id");
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      emitTauriEvent("deeplink-import", desktopRequest);
    });
    await screen.findByRole("button", { name: "deeplink.importAndSwitch" });
    fireEvent.click(
      screen.getByRole("button", { name: "deeplink.importAndSwitch" }),
    );

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith(
        expect.objectContaining({ app: "claude-desktop", enabled: true }),
      );
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["providers", "claude-desktop"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["claudeDesktopStatus"],
    });
  });

  it("preserves the enabled value from existing Claude links", async () => {
    const importSpy = vi
      .spyOn(deeplinkApi, "importFromDeeplink")
      .mockResolvedValue({ type: "provider", id: "claude-id" });
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });
    const claudeRequest = {
      ...desktopRequest,
      app: "claude" as const,
      enabled: true,
    };

    act(() => {
      emitTauriEvent("deeplink-import", claudeRequest);
    });
    await screen.findByRole("button", { name: "deeplink.import" });
    fireEvent.click(screen.getByRole("button", { name: "deeplink.import" }));

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith(claudeRequest);
    });
  });

  it("keeps the import dialog available when a Claude Desktop import fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(deeplinkApi, "importFromDeeplink").mockRejectedValue(
      new Error("desktop import failed"),
    );
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      emitTauriEvent("deeplink-import", desktopRequest);
    });
    await screen.findByRole("button", { name: "deeplink.importOnly" });
    fireEvent.click(
      screen.getByRole("button", { name: "deeplink.importOnly" }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "deeplink.importOnly" }),
      ).toBeEnabled();
    });
  });

  it("renders masked usage access token and user id for provider imports", async () => {
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      emitTauriEvent("deeplink-import", {
        version: "v1",
        resource: "provider",
        app: "claude",
        name: "Test Provider",
        homepage: "https://example.com",
        endpoint: "https://api.example.com",
        apiKey: "sk-provider-key",
        usageEnabled: true,
        usageScript: btoa("console.log('usage');"),
        usageApiKey: "sk-usage-key",
        usageBaseUrl: "https://usage.example.com",
        usageAccessToken: "pat-secret-token",
        usageUserId: "user-12345",
        usageAutoInterval: 60,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("用量访问令牌")).toBeInTheDocument();
    });

    expect(screen.getByText("用量用户 ID")).toBeInTheDocument();
    expect(screen.getByText("user-12345")).toBeInTheDocument();
    // Masked: first 4 chars + 12 stars
    expect(screen.getByText("pat-************")).toBeInTheDocument();
  });

  it("shows usage credentials even when the deeplink carries no usageScript", async () => {
    // 后端 build_provider_meta 在任一 usage 字段存在时即持久化（含 access_token
    // 与 user_id）。若对话框只在 usageScript 存在时开门，这条链接会把凭据静默
    // 写进供应商配置。撤销门槛 widening（恢复只按 usageScript 开门）本测试即失败。
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      emitTauriEvent("deeplink-import", {
        version: "v1",
        resource: "provider",
        app: "claude",
        name: "Token Only Provider",
        homepage: "https://example.com",
        endpoint: "https://api.example.com",
        apiKey: "sk-provider-key",
        usageAccessToken: "pat-secret-token",
        usageUserId: "user-12345",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("用量访问令牌")).toBeInTheDocument();
    });

    expect(screen.getByText("pat-************")).toBeInTheDocument();
    expect(screen.getByText("用量用户 ID")).toBeInTheDocument();
    expect(screen.getByText("user-12345")).toBeInTheDocument();
    // 没有脚本就不应渲染脚本执行警告与脚本代码区
    expect(
      screen.queryByText(
        "这是一段 JavaScript 代码，启用后会在查询用量时执行。请确认来源可信后再导入。",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("脚本代码")).not.toBeInTheDocument();
  });
});
