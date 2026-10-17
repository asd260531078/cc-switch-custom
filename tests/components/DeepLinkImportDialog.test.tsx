import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { Profiler } from "react";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { deeplinkApi } from "@/lib/api/deeplink";
import { http, HttpResponse } from "msw";
import i18n from "i18next";
import { emitTauriEvent } from "../msw/tauriMocks";
import { server } from "../msw/server";
import { peekPendingDeepLink, setPendingDeepLink } from "../msw/state";
import { pngDataUri } from "../fixtures/customIcon";
import { toast } from "@/lib/toast";

// jsdom 没有 canvas，重新编码这一步换成可控的假实现
const { normalizeIconDataUri } = vi.hoisted(() => ({
  normalizeIconDataUri: vi.fn<(dataUri: string) => Promise<string>>(),
}));
vi.mock("@/utils/customIcon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/customIcon")>()),
  normalizeIconDataUri,
}));

// 模拟后端：先暂存链接，再发 deeplink-pending 通知前端来取
const deliverDeepLink = (request: Record<string, unknown>) => {
  setPendingDeepLink({ kind: "import", request });
  emitTauriEvent("deeplink-pending", null);
};

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
  beforeEach(() => {
    normalizeIconDataUri.mockReset();
    server.use(
      http.post("http://tauri.local/get_provider_logo", () =>
        HttpResponse.json(null),
      ),
    );
  });

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

  const piRequest = {
    version: "v1",
    resource: "provider" as const,
    app: "pi" as const,
    name: "Pi 测试 + & %",
    endpoint: "https://api.example.com/v1",
    apiKey: "sk-pi-test-secret",
    model: "vendor/model+one",
    icon: "pi",
    iconUrl: "https://logo.example.com/Logo%2FOne.png?Case=A%2BB",
    enabled: true,
  };

  it.each([
    ["deeplink.importOnly", false],
    ["deeplink.importAndEnablePi", true],
  ] as const)(
    "imports Pi via %s and refreshes native membership",
    async (action, enabled) => {
      const importSpy = vi
        .spyOn(deeplinkApi, "importFromDeeplink")
        .mockResolvedValue({ type: "provider", id: "pi-id" });
      const invalidateSpy = vi.spyOn(
        QueryClient.prototype,
        "invalidateQueries",
      );
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      act(() => {
        deliverDeepLink(piRequest);
      });

      expect(await screen.findByText(piRequest.model)).toBeInTheDocument();
      expect(screen.getByText("deeplink.piImportHint")).toBeInTheDocument();
      expect(
        screen.queryByText("deeplink.desktopImportHint"),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
      expect(screen.queryByText(piRequest.apiKey)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "deeplink.importAndSwitch" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: action }));

      await waitFor(() =>
        expect(importSpy).toHaveBeenCalledWith({ ...piRequest, enabled }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["providers", "pi"],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["pi", "currentState"],
      });
    },
  );

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
      deliverDeepLink({ ...desktopRequest, config });
    });

    await screen.findByText("deeplink.defaultModel");
    expect(screen.getByText("claude-haiku-4-5")).toBeInTheDocument();
    expect(screen.getAllByText("claude-sonnet-4-5")).toHaveLength(2);
    expect(screen.getByText("claude-opus-4-5")).toBeInTheDocument();
    expect(screen.getByText("desk************")).toBeInTheDocument();
    expect(screen.queryByText("desktop-config-secret")).not.toBeInTheDocument();
    expect(screen.getByText(/NODE_OPTIONS/)).toBeInTheDocument();
  });

  it("keeps Pi actions disabled while importing and allows retry after failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let rejectImport!: (error: Error) => void;
    const importSpy = vi
      .spyOn(deeplinkApi, "importFromDeeplink")
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectImport = reject;
          }),
      )
      .mockResolvedValueOnce("pi-legacy-id");
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });
    act(() => {
      deliverDeepLink(piRequest);
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "deeplink.importAndEnablePi" }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: "deeplink.importing" }),
      ).toHaveLength(2);
      expect(
        screen.getByRole("button", { name: "common.cancel" }),
      ).toBeDisabled();
      for (const button of screen.getAllByRole("button", {
        name: "deeplink.importing",
      })) {
        expect(button).toBeDisabled();
        fireEvent.click(button);
      }
    });
    expect(importSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectImport(new Error("Pi fixture write failed"));
    });
    expect(
      await screen.findByRole("button", { name: "deeplink.importOnly" }),
    ).toBeEnabled();
    expect(invalidateSpy).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "deeplink.importOnly" }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["pi", "currentState"],
      }),
    );
    expect(importSpy).toHaveBeenLastCalledWith({
      ...piRequest,
      enabled: false,
    });
    await waitFor(() =>
      expect(screen.queryByText(piRequest.name)).not.toBeInTheDocument(),
    );
  });

  it("cancels a Pi link without importing or enabling it", async () => {
    const importSpy = vi.spyOn(deeplinkApi, "importFromDeeplink");
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });
    act(() => {
      deliverDeepLink(piRequest);
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "common.cancel" }),
    );
    expect(importSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(piRequest.name)).not.toBeInTheDocument();
  });

  it("imports Claude Desktop disabled even when the link requests enabled", async () => {
    const importSpy = vi
      .spyOn(deeplinkApi, "importFromDeeplink")
      .mockResolvedValue({ type: "provider", id: "desktop-id" });
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      deliverDeepLink({ ...desktopRequest, enabled: true });
    });
    await screen.findByRole("button", { name: "deeplink.importOnly" });
    expect(screen.getByText("deeplink.desktopImportHint")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
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
      deliverDeepLink(desktopRequest);
    });
    await screen.findByRole("button", { name: "deeplink.importAndSwitch" });
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
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
      deliverDeepLink(claudeRequest);
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
      deliverDeepLink(desktopRequest);
    });
    await screen.findByRole("button", { name: "deeplink.importOnly" });
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "deeplink.importOnly" }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "deeplink.importOnly" }),
      ).toBeEnabled();
    });
  });

  it.each([
    { app: "opencode", enabled: true, fails: false, refreshes: true },
    { app: "opencode", enabled: false, fails: false, refreshes: true },
    {
      app: "opencode",
      enabled: true,
      fails: false,
      refreshes: true,
      legacy: true,
    },
    {
      app: "opencode",
      enabled: false,
      fails: false,
      refreshes: true,
      legacy: true,
    },
    { app: "opencode", enabled: true, fails: true, refreshes: false },
    { app: "claude", enabled: true, fails: false, refreshes: false },
  ])(
    "refreshes OpenCode live data only after its successful import: %j",
    async ({ app, enabled, fails, refreshes, legacy }) => {
      const success = vi.spyOn(toast, "success");
      const failure = vi.spyOn(toast, "error");
      const client = new QueryClient({
        defaultOptions: { queries: { staleTime: Infinity, retry: false } },
      });
      let liveIds: string[] = [];
      let models: string[] = [];
      const readLiveIds = vi.fn(async () => liveIds);
      const readModels = vi.fn(async () => models);
      const importProvider = vi.fn(async () => {
        if (fails)
          return HttpResponse.json(
            { message: "Import failed" },
            { status: 500 },
          );
        if (app === "opencode" && enabled) {
          liveIds = ["imported-provider"];
          models = ["imported-provider/model"];
        }
        return HttpResponse.json(
          legacy
            ? "imported-provider"
            : { type: "provider", id: "imported-provider" },
        );
      });
      server.use(
        http.post(
          "http://tauri.local/import_from_deeplink_unified",
          importProvider,
        ),
      );
      function LiveState() {
        const ids = useQuery({
          queryKey: ["opencodeLiveProviderIds"],
          queryFn: readLiveIds,
        });
        const runtimeModels = useQuery({
          queryKey: ["opencode", "runtime-models"],
          queryFn: readModels,
        });
        return (
          <>
            <output data-testid="live-ids">{JSON.stringify(ids.data)}</output>
            <output data-testid="runtime-models">
              {JSON.stringify(runtimeModels.data)}
            </output>
          </>
        );
      }
      render(
        <QueryClientProvider client={client}>
          <LiveState />
          <DeepLinkImportDialog />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(screen.getByTestId("live-ids")).toHaveTextContent("[]"),
      );
      await waitFor(() =>
        expect(screen.getByTestId("runtime-models")).toHaveTextContent("[]"),
      );
      act(() =>
        deliverDeepLink({
          version: "v1",
          resource: "provider",
          app,
          enabled,
          name: "Imported Provider",
          endpoint: "https://example.com/v1",
          apiKey: "public-test-key",
        }),
      );
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: "deeplink.import" }),
      );
      await waitFor(() => expect(importProvider).toHaveBeenCalledTimes(1));
      if (fails) {
        await waitFor(() => expect(failure).toHaveBeenCalled());
      } else {
        await waitFor(() => expect(success).toHaveBeenCalled());
      }
      expect(readLiveIds).toHaveBeenCalledTimes(refreshes ? 2 : 1);
      expect(readModels).toHaveBeenCalledTimes(refreshes ? 2 : 1);
      const shouldBeLive = refreshes && enabled;
      await waitFor(() =>
        expect(screen.getByTestId("live-ids")).toHaveTextContent(
          shouldBeLive ? '["imported-provider"]' : "[]",
        ),
      );
      await waitFor(() =>
        expect(screen.getByTestId("runtime-models")).toHaveTextContent(
          shouldBeLive ? '["imported-provider/model"]' : "[]",
        ),
      );
      client.clear();
      success.mockRestore();
      failure.mockRestore();
    },
  );

  it("renders masked usage access token and user id for provider imports", async () => {
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      deliverDeepLink({
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
      deliverDeepLink({
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

  // 自定义脚本只有明确 usageEnabled=true 才启用，缺省仍须用户主动开启。
  it.each([
    { usageEnabled: undefined, expected: "未启用" },
    { usageEnabled: true, expected: "已启用" },
    { usageEnabled: false, expected: "未启用" },
  ])(
    "shows the usage badge as $expected when usageEnabled is $usageEnabled and a script is attached",
    async ({ usageEnabled, expected }) => {
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });

      act(() => {
        deliverDeepLink({
          version: "v1",
          resource: "provider",
          app: "claude",
          name: "Usage Provider",
          homepage: "https://example.com",
          endpoint: "https://api.example.com",
          apiKey: "sk-provider-key",
          usageScript: btoa("console.log('usage');"),
          ...(usageEnabled === undefined ? {} : { usageEnabled }),
        });
      });

      await waitFor(() => {
        expect(screen.getByText(expected)).toBeInTheDocument();
      });
    },
  );

  // 套餐地址、不带脚本：后端按套餐额度查询并默认启用，徽章与后端一致
  it.each([
    {
      app: "codex",
      endpoint: "https://api.kimi.com/coding/v1",
      usageEnabled: undefined,
      expected: "已启用",
    },
    {
      app: "codex",
      endpoint: "https://api.kimi.com/coding/v1",
      usageEnabled: false,
      expected: "未启用",
    },
  ])(
    "shows the plan quota badge as $expected for $app with usageEnabled $usageEnabled",
    async ({ app, endpoint, usageEnabled, expected }) => {
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });

      act(() => {
        deliverDeepLink({
          version: "v1",
          resource: "provider",
          app,
          name: "Plan Provider",
          homepage: "https://example.com",
          endpoint,
          apiKey: "sk-provider-key",
          ...(usageEnabled === undefined ? {} : { usageEnabled }),
        });
      });

      await waitFor(() => {
        expect(screen.getByText(expected)).toBeInTheDocument();
      });
      expect(screen.getByText("套餐额度：Kimi For Coding")).toBeInTheDocument();
    },
  );

  it("does not show a usage row for ZenMux outside Claude", async () => {
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      deliverDeepLink({
        version: "v1",
        resource: "provider",
        app: "codex",
        name: "ZenMux Provider",
        homepage: "https://example.com",
        endpoint: "https://zenmux.ai/api/v1",
        apiKey: "sk-provider-key",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("ZenMux Provider")).toBeInTheDocument();
    });
    expect(screen.queryByText("用量查询")).not.toBeInTheDocument();
  });

  it("shows a link that arrived before the dialog mounted (cold start)", async () => {
    // 冷启动时链接早于前端监听到达，后端已暂存；组件挂载后必须主动取一次
    setPendingDeepLink({
      kind: "import",
      request: {
        version: "v1",
        resource: "provider",
        app: "claude",
        name: "Cold Start Provider",
        homepage: "https://example.com",
        endpoint: "https://api.example.com",
        apiKey: "sk-provider-key",
      },
    });

    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText("Cold Start Provider")).toBeInTheDocument();
    });
  });

  it("warns that enabled=true switches to the provider right after import", async () => {
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      deliverDeepLink({
        version: "v1",
        resource: "provider",
        app: "claude",
        name: "Switching Provider",
        homepage: "https://example.com",
        endpoint: "https://api.example.com",
        apiKey: "sk-provider-key",
        enabled: true,
      });
    });

    await waitFor(() => {
      expect(
        screen.getByText("deeplink.providerEnabledWarning"),
      ).toBeInTheDocument();
    });
  });

  it("does not show the switch warning when enabled is absent", async () => {
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      deliverDeepLink({
        version: "v1",
        resource: "provider",
        app: "claude",
        name: "Add Only Provider",
        homepage: "https://example.com",
        endpoint: "https://api.example.com",
        apiKey: "sk-provider-key",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Add Only Provider")).toBeInTheDocument();
    });
    expect(
      screen.queryByText("deeplink.providerEnabledWarning"),
    ).not.toBeInTheDocument();
  });

  describe("the activate-after-import switch", () => {
    // 记下导入请求里的 enabled：开关的值必须覆盖链接里的 enabled
    const captureImport = () => {
      const sent: Array<Record<string, unknown>> = [];
      server.use(
        http.post(
          "http://tauri.local/import_from_deeplink_unified",
          async ({ request }) => {
            const body = (await request.json()) as {
              request: Record<string, unknown>;
            };
            sent.push(body.request);
            return HttpResponse.json(
              body.request.resource === "prompt"
                ? { type: "prompt", id: "p1" }
                : { type: "provider", id: "p1" },
            );
          },
        ),
      );
      return sent;
    };

    const providerLink = (extra: Record<string, unknown>) => ({
      version: "v1",
      resource: "provider",
      name: "Toggle Provider",
      homepage: "https://example.com",
      endpoint: "https://api.example.com",
      apiKey: "sk-provider-key",
      ...extra,
    });

    it.each([
      {
        resource: "provider",
        app: "opencode",
      },
      {
        resource: "prompt",
        app: "claude",
        content: btoa("# review"),
        enabled: true,
      },
    ])(
      "shows the correct activation state on the first $resource render",
      async (link) => {
        const renderedStates: Array<string | null> = [];
        render(
          <Profiler
            id="deeplink-activation"
            onRender={() => {
              // Observe every committed render, before passive effects can fix a stale value.
              const toggle = screen.queryByRole("switch");
              if (toggle)
                renderedStates.push(toggle.getAttribute("aria-checked"));
            }}
          >
            <DeepLinkImportDialog />
          </Profiler>,
          { wrapper: Wrapper },
        );
        act(() => deliverDeepLink(providerLink(link)));

        await screen.findByRole("switch");
        expect(renderedStates.length).toBeGreaterThan(0);
        expect(new Set(renderedStates)).toEqual(new Set(["true"]));
      },
    );

    it("starts from the link's enabled and lets the user turn switching off", async () => {
      const sent = captureImport();
      const user = userEvent.setup();
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      act(() =>
        deliverDeepLink(providerLink({ app: "claude", enabled: true })),
      );

      const toggle = await screen.findByRole("switch");
      expect(toggle).toBeChecked();
      expect(
        screen.getByText("deeplink.providerEnabledWarning"),
      ).toBeInTheDocument();

      await user.click(toggle);
      expect(toggle).not.toBeChecked();
      expect(
        screen.queryByText("deeplink.providerEnabledWarning"),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "deeplink.import" }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].enabled).toBe(false);
    });

    it("lets the user opt into switching when the link does not ask for it", async () => {
      const sent = captureImport();
      const user = userEvent.setup();
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      act(() => deliverDeepLink(providerLink({ app: "codex" })));

      const toggle = await screen.findByRole("switch");
      expect(toggle).not.toBeChecked();
      expect(
        screen.getByText("deeplink.switchAfterImport"),
      ).toBeInTheDocument();

      await user.click(toggle);
      expect(
        screen.getByText("deeplink.providerEnabledWarning"),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "deeplink.import" }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].enabled).toBe(true);
    });

    it("adds additive-app providers to the app config unless the link opts out", async () => {
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      act(() => deliverDeepLink(providerLink({ app: "opencode" })));

      const toggle = await screen.findByRole("switch");
      expect(toggle).toBeChecked();
      expect(
        screen.getByText("deeplink.addToAppAfterImport"),
      ).toBeInTheDocument();
      // 累加式应用没有「切换」，不提示改发请求
      expect(
        screen.queryByText("deeplink.providerEnabledWarning"),
      ).not.toBeInTheDocument();
    });

    it("lets the user decide whether an imported prompt is enabled", async () => {
      const sent = captureImport();
      const user = userEvent.setup();
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      act(() =>
        deliverDeepLink({
          version: "v1",
          resource: "prompt",
          app: "claude",
          name: "Review Prompt",
          content: btoa("# review"),
          enabled: true,
        }),
      );

      const toggle = await screen.findByRole("switch");
      expect(toggle).toBeChecked();
      expect(
        screen.getByText("deeplink.prompt.enabledWarning"),
      ).toBeInTheDocument();

      await user.click(toggle);
      await user.click(screen.getByRole("button", { name: "deeplink.import" }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].enabled).toBe(false);
    });
  });

  describe("the link's iconUrl", () => {
    const CACHED_LOGO = pngDataUri(96, 96);

    const iconLink = (extra: Record<string, unknown> = {}) => ({
      version: "v1",
      resource: "provider",
      app: "claude",
      name: "Icon Provider",
      endpoint: "https://api.example.com",
      apiKey: "sk-provider-key",
      iconUrl: "https://cdn.example.com/Logo.svg?Case=A%2BB",
      ...extra,
    });

    // 预览使用后端 Logo 缓存；旧下载接口不得进入导入流程。
    const mockBackend = (loadLogo: () => Promise<string | null>) => {
      const fetched: string[] = [];
      const legacyDownloads: string[] = [];
      const sent: Array<Record<string, unknown>> = [];
      server.use(
        http.post(
          "http://tauri.local/get_provider_logo",
          async ({ request }) => {
            const { iconUrl } = (await request.json()) as { iconUrl: string };
            fetched.push(iconUrl);
            return HttpResponse.json(await loadLogo());
          },
        ),
        http.post(
          "http://tauri.local/fetch_deeplink_icon",
          async ({ request }) => {
            const { url } = (await request.json()) as { url: string };
            legacyDownloads.push(url);
            return HttpResponse.json(null);
          },
        ),
        http.post(
          "http://tauri.local/import_from_deeplink_unified",
          async ({ request }) => {
            const body = (await request.json()) as {
              request: Record<string, unknown>;
            };
            sent.push(body.request);
            return HttpResponse.json({ type: "provider", id: "p1" });
          },
        ),
      );
      return { fetched, legacyDownloads, sent };
    };

    it("previews the cached logo and imports the original URL with its built-in fallback", async () => {
      const { fetched, legacyDownloads, sent } = mockBackend(
        async () => CACHED_LOGO,
      );
      const request = iconLink({ icon: "deepseek" });
      const user = userEvent.setup();
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      act(() => deliverDeepLink(request));

      const preview = await screen.findByAltText("Icon Provider");
      expect(preview).toHaveAttribute("src", CACHED_LOGO);
      expect(fetched).toEqual([request.iconUrl]);
      expect(legacyDownloads).toHaveLength(0);
      expect(normalizeIconDataUri).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "deeplink.import" }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toEqual({ ...request, enabled: false });
    });

    it("preserves the original URL and built-in icon when the cache load fails", async () => {
      const { fetched, legacyDownloads, sent } = mockBackend(async () => null);
      const request = iconLink({
        icon: "deepseek",
        iconUrl: "https://failed-cache.example.com/logo.svg",
      });
      const user = userEvent.setup();
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      act(() => deliverDeepLink(request));

      await waitFor(() => expect(fetched).toEqual([request.iconUrl]));
      await user.click(screen.getByRole("button", { name: "deeplink.import" }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].icon).toBe("deepseek");
      expect(sent[0].iconUrl).toBe(request.iconUrl);
      expect(legacyDownloads).toHaveLength(0);
      expect(normalizeIconDataUri).not.toHaveBeenCalled();
    });

    it("keeps the URL without converting an invalid cache response into an uploaded icon", async () => {
      const { fetched, legacyDownloads, sent } = mockBackend(
        async () => "data:image/svg+xml;base64,PHN2Zy8+",
      );
      const request = iconLink({
        iconUrl: "https://invalid-cache.example.com/logo.svg",
      });
      const user = userEvent.setup();
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      act(() => deliverDeepLink(request));

      expect(await screen.findByText("IP")).toBeInTheDocument();
      await waitFor(() => expect(fetched).toEqual([request.iconUrl]));
      expect(screen.queryByAltText("Icon Provider")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "deeplink.import" }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].icon).toBeUndefined();
      expect(sent[0].iconUrl).toBe(request.iconUrl);
      expect(legacyDownloads).toHaveLength(0);
      expect(normalizeIconDataUri).not.toHaveBeenCalled();
    });

    it("imports without waiting for an in-flight logo cache load", async () => {
      let finishLoad!: (value: string) => void;
      const load = new Promise<string>((resolve) => {
        finishLoad = resolve;
      });
      const { fetched, legacyDownloads, sent } = mockBackend(() => load);
      const request = iconLink({
        iconUrl: "https://pending-cache.example.com/logo.svg",
      });
      const user = userEvent.setup();
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      act(() => deliverDeepLink(request));

      await waitFor(() => expect(fetched).toEqual([request.iconUrl]));
      await user.click(screen.getByRole("button", { name: "deeplink.import" }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].icon).toBeUndefined();
      expect(sent[0].iconUrl).toBe(request.iconUrl);
      expect(legacyDownloads).toHaveLength(0);
      expect(normalizeIconDataUri).not.toHaveBeenCalled();
      await act(async () => finishLoad(CACHED_LOGO));
    });

    it("does not request a logo for links without iconUrl", async () => {
      const { fetched, legacyDownloads, sent } = mockBackend(
        async () => CACHED_LOGO,
      );
      const request = iconLink({ iconUrl: undefined, icon: "deepseek" });
      const user = userEvent.setup();
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      act(() => deliverDeepLink(request));

      await user.click(
        await screen.findByRole("button", { name: "deeplink.import" }),
      );
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(fetched).toHaveLength(0);
      expect(legacyDownloads).toHaveLength(0);
      expect(sent[0].icon).toBe("deepseek");
      expect(sent[0].iconUrl).toBeUndefined();
    });
  });

  describe("when processing is interrupted after the link was read", () => {
    const coldStartLink = {
      kind: "import",
      request: {
        version: "v1",
        resource: "provider",
        app: "claude",
        name: "Interrupted Provider",
        homepage: "https://example.com",
        endpoint: "https://api.example.com",
        apiKey: "sk-provider-key",
      },
    };

    // 让 peek 的响应停在半路：返回 hit（请求已到达）与 release（放行响应）
    const holdPeek = () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let markHit!: () => void;
      const hit = new Promise<void>((resolve) => (markHit = resolve));
      server.use(
        http.post("http://tauri.local/peek_pending_deeplink", async () => {
          const entry = peekPendingDeepLink();
          markHit();
          await gate;
          return HttpResponse.json(entry);
        }),
      );
      return { hit, release };
    };

    afterEach(async () => {
      await act(async () => {
        await i18n.changeLanguage("zh");
      });
    });

    it("still shows the link when the language changes mid-read", async () => {
      // 启动时按后端设置校正语言会换掉 t；effect 若随 t 重建，读到一半的链接就被丢下
      setPendingDeepLink(coldStartLink);
      const { hit, release } = holdPeek();

      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      await hit;
      await act(async () => {
        await i18n.changeLanguage("en");
      });
      release();

      await waitFor(() => {
        expect(screen.getByText("Interrupted Provider")).toBeInTheDocument();
      });
      await waitFor(() => expect(peekPendingDeepLink()).toBeNull());
    });

    it("keeps the link for the next mount when unmounted mid-read", async () => {
      // 窗口销毁重建：旧实例读到了但没显示，链接必须留在后端给新实例
      setPendingDeepLink(coldStartLink);
      const { hit, release } = holdPeek();

      const first = render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      await hit;
      first.unmount();
      release();
      server.resetHandlers();

      expect(peekPendingDeepLink()).not.toBeNull();
      render(<DeepLinkImportDialog />, { wrapper: Wrapper });

      await waitFor(() => {
        expect(screen.getByText("Interrupted Provider")).toBeInTheDocument();
      });
    });

    it("does not let a late read of an older link replace a newer one", async () => {
      // A 的读取响应迟到；期间 B 到达。若读取可以并发，B 先显示并被清除，
      // A 随后返回把 B 盖掉，B 从界面消失、后端也取不回来了
      const providerLink = (name: string) => ({
        ...coldStartLink,
        request: { ...coldStartLink.request, name },
      });
      setPendingDeepLink(providerLink("Older Provider"));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let markHit!: () => void;
      const hit = new Promise<void>((resolve) => (markHit = resolve));
      let calls = 0;
      server.use(
        http.post("http://tauri.local/peek_pending_deeplink", async () => {
          const entry = peekPendingDeepLink();
          if (++calls === 1) {
            markHit();
            await gate;
          }
          return HttpResponse.json(entry);
        }),
      );

      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      await hit;
      act(() => {
        deliverDeepLink(providerLink("Newer Provider").request);
      });
      // 给并发读取（如果有）留出完成的时间
      await new Promise((resolve) => setTimeout(resolve, 30));
      release();

      await waitFor(() => {
        expect(screen.getByText("Newer Provider")).toBeInTheDocument();
      });
      await waitFor(() => expect(peekPendingDeepLink()).toBeNull());
      expect(screen.queryByText("Older Provider")).not.toBeInTheDocument();
    });

    it("shows the newer link when it arrives while the older one is merging its config", async () => {
      // 读取已返回 A，A 带 config 正在合并（异步），此时 B 到达：最终必须停在 B
      setPendingDeepLink({
        ...coldStartLink,
        request: {
          ...coldStartLink.request,
          name: "Merging Provider",
          config: btoa('{"env":{}}'),
        },
      });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let markHit!: () => void;
      const hit = new Promise<void>((resolve) => (markHit = resolve));
      server.use(
        http.post(
          "http://tauri.local/merge_deeplink_config",
          async ({ request }) => {
            const body = (await request.json()) as {
              request: Record<string, unknown>;
            };
            markHit();
            await gate;
            return HttpResponse.json(body.request);
          },
        ),
      );

      render(<DeepLinkImportDialog />, { wrapper: Wrapper });
      await hit;
      act(() => {
        deliverDeepLink({
          ...coldStartLink.request,
          name: "Arrived During Merge",
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      release();

      await waitFor(() => {
        expect(screen.getByText("Arrived During Merge")).toBeInTheDocument();
      });
      await waitFor(() => expect(peekPendingDeepLink()).toBeNull());
      expect(screen.queryByText("Merging Provider")).not.toBeInTheDocument();
    });
  });
});
