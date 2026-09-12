import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { ProviderCard } from "@/components/providers/ProviderCard";
import { GrokBuildProviderForm } from "@/components/providers/forms/GrokBuildProviderForm";
import { deeplinkApi } from "@/lib/api/deeplink";
import type { Provider } from "@/types";
import { emitTauriEvent } from "../msw/tauriMocks";
import { createTestQueryClient } from "../utils/testQueryClient";

const iconProps = vi.hoisted(() => vi.fn());

vi.mock("@/components/ProviderIcon", () => ({
  ProviderIcon: (props: unknown) => {
    iconProps(props);
    return <span data-testid="provider-icon" />;
  },
}));

vi.mock("@/components/JsonEditor", () => ({
  default: () => <textarea aria-label="raw-config" />,
}));

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
  DialogTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DialogClose: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/providers/ProviderActions", () => ({
  ProviderActions: () => null,
}));
vi.mock("@/components/UsageFooter", () => ({ default: () => null }));
vi.mock("@/components/SubscriptionQuotaFooter", () => ({
  default: () => null,
}));
vi.mock("@/components/CopilotQuotaFooter", () => ({ default: () => null }));
vi.mock("@/components/CodexOauthQuotaFooter", () => ({
  default: () => null,
}));
vi.mock("@/components/XaiOauthQuotaFooter", () => ({ default: () => null }));
vi.mock("@/lib/query/failover", () => ({
  useProviderHealth: () => ({ data: undefined }),
}));
vi.mock("@/lib/query/queries", () => ({
  useUsageQuery: () => ({ data: undefined }),
}));

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={createTestQueryClient()}>
    {children}
  </QueryClientProvider>
);

const BASE_GROK_CONFIG = `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://relay.example.com/v1"
name = "Example Relay"
api_key = "secret-key"
api_backend = "responses"
context_window = 500000
`;

const provider = (id: string, iconUrl: string): Provider => ({
  id,
  name: id,
  settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://shared.example/v1" } },
  icon: "openai",
  meta: { iconUrl },
});

function renderCard(item: Provider) {
  return render(
    <Wrapper>
      <ProviderCard
        provider={item}
        appId="claude"
        isCurrent={false}
        isProxyRunning={false}
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onConfigureUsage={vi.fn()}
        onOpenWebsite={vi.fn()}
        onDuplicate={vi.fn()}
      />
    </Wrapper>,
  );
}

describe("provider website logo flow", () => {
  afterEach(() => {
    iconProps.mockClear();
    vi.restoreAllMocks();
  });

  it("passes the original deep-link icon URL to preview and import without changing other parameters", async () => {
    const request = {
      version: "v1",
      resource: "provider" as const,
      app: "claude" as const,
      name: "Preview Relay",
      icon: "openai",
      iconUrl: "https://cdn.example.com/Logo%2FOriginal.png?x=MiXeD",
      endpoint: "https://api.example.com/v1",
      apiKey: "sk-original",
      model: "claude-sonnet-4-5",
    };
    const importSpy = vi
      .spyOn(deeplinkApi, "importFromDeeplink")
      .mockResolvedValue({ type: "provider", id: "preview-relay" });

    render(<DeepLinkImportDialog />, { wrapper: Wrapper });
    act(() => emitTauriEvent("deeplink-import", request));

    await screen.findByRole("button", { name: "deeplink.import" });
    expect(iconProps).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: "openai",
        iconUrl: request.iconUrl,
        name: "Preview Relay",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "deeplink.import" }));
    await waitFor(() => expect(importSpy).toHaveBeenCalledWith(request));
  });

  it("keeps each card's logo source when providers share the same endpoint", () => {
    const first = provider(
      "First Relay",
      "https://logos.example.com/first.png",
    );
    const second = provider(
      "Second Relay",
      "https://logos.example.com/second.png",
    );
    renderCard(first);
    renderCard(second);

    expect(iconProps).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "First Relay",
        iconUrl: first.meta?.iconUrl,
      }),
    );
    expect(iconProps).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Second Relay",
        iconUrl: second.meta?.iconUrl,
      }),
    );
  });

  it("saves an edited logo URL while preserving unrelated metadata", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <GrokBuildProviderForm
        providerId="saved-relay"
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initialData={{
          name: "Example Relay",
          settingsConfig: { config: BASE_GROK_CONFIG },
          meta: {
            usage_script: { enabled: false, language: "javascript", code: "" },
          },
        }}
      />,
    );

    await user.type(
      screen.getByPlaceholderText("https://example.com/logo.png"),
      "https://cdn.example.com/Logo%2FOriginal.png?x=MiXeD",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta).toMatchObject({
      iconUrl: "https://cdn.example.com/Logo%2FOriginal.png?x=MiXeD",
      usage_script: { enabled: false, language: "javascript", code: "" },
    });
  });

  it("clears an existing logo URL without dropping unrelated metadata", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <GrokBuildProviderForm
        providerId="saved-relay"
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initialData={{
          name: "Example Relay",
          settingsConfig: { config: BASE_GROK_CONFIG },
          meta: {
            iconUrl: "https://cdn.example.com/current.png",
            usage_script: { enabled: false, language: "javascript", code: "" },
          },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "清除" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta).toMatchObject({
      usage_script: { enabled: false, language: "javascript", code: "" },
    });
    expect(onSubmit.mock.calls[0][0].meta.iconUrl).toBeUndefined();
  });
});
