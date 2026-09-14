import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import { ProviderForm } from "@/components/providers/forms/ProviderForm";
import type { AppId } from "@/lib/api";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("@/components/JsonEditor", () => ({ default: () => null }));
vi.mock("@/components/providers/forms/CodexConfigEditor", () => ({
  default: () => null,
}));
vi.mock("@/components/providers/forms/ProviderAdvancedConfig", () => ({
  ProviderAdvancedConfig: () => null,
}));
vi.mock("@/components/providers/forms/hooks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/providers/forms/hooks")>();
  const auth = {
    isAuthenticated: false,
    isStatusSuccess: true,
    isStatusError: false,
    accounts: [],
  };
  const common = {
    useCommonConfig: false,
    commonConfigSnippet: "",
    commonConfigError: null,
    isLoading: false,
    isExtracting: false,
    handleCommonConfigToggle: vi.fn(),
    handleCommonConfigSnippetChange: vi.fn(),
    handleExtract: vi.fn(),
    clearCommonConfigError: vi.fn(),
  };
  return {
    ...actual,
    useCopilotAuth: () => auth,
    useCodexOauth: () => auth,
    useXaiOauth: () => auth,
    useCommonConfigSnippet: () => common,
    useCodexCommonConfig: () => common,
    useGeminiCommonConfig: () => common,
  };
});
vi.mock("@/lib/query/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query/queries")>();
  const providers = {
    data: { providers: {}, current: "" },
    isSuccess: true,
    isLoading: false,
  };
  return { ...actual, useProvidersQuery: () => providers };
});
vi.mock("@/lib/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query")>();
  return {
    ...actual,
    useSettingsQuery: () => ({ data: { commonConfigConfirmed: true } }),
  };
});
vi.mock("@/lib/api/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/providers")>();
  return {
    ...actual,
    providersApi: {
      ...actual.providersApi,
      getHermesLiveProviderIds: async () => [],
    },
  };
});

type Case = {
  appId: AppId;
  name: string;
  baseUrl: string;
  format?: string;
  keyField?: string;
};
const cases: Case[] = [
  {
    appId: "claude",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    format: "openai_responses",
  },
  {
    appId: "claude",
    name: "Claude",
    baseUrl: "https://api.anthropic.com",
    format: "anthropic",
    keyField: "ANTHROPIC_API_KEY",
  },
  {
    appId: "claude",
    name: "Gemini Native",
    baseUrl: "https://generativelanguage.googleapis.com",
    format: "gemini_native",
    keyField: "ANTHROPIC_API_KEY",
  },
  {
    appId: "claude",
    name: "Grok",
    baseUrl: "https://api.x.ai/v1",
    format: "openai_responses",
  },
  {
    appId: "codex",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    format: "openai_responses",
  },
  {
    appId: "codex",
    name: "Claude",
    baseUrl: "https://api.anthropic.com",
    format: "anthropic",
    keyField: "ANTHROPIC_API_KEY",
  },
  {
    appId: "codex",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    format: "openai_chat",
  },
  {
    appId: "codex",
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    format: "openai_responses",
  },
  {
    appId: "gemini",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
  },
  ...(["opencode", "openclaw", "hermes"] as const).flatMap((appId) => [
    {
      appId,
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      format:
        appId === "opencode"
          ? "@ai-sdk/openai"
          : appId === "openclaw"
            ? "openai-responses"
            : "codex_responses",
    },
    {
      appId,
      name: "Claude",
      baseUrl:
        "https://api.anthropic.com" + (appId === "opencode" ? "/v1" : ""),
      format:
        appId === "opencode"
          ? "@ai-sdk/anthropic"
          : appId === "openclaw"
            ? "anthropic-messages"
            : "anthropic_messages",
    },
    {
      appId,
      name: "Gemini",
      baseUrl:
        "https://generativelanguage.googleapis.com/v1beta" +
        (appId === "hermes" ? "/openai/" : ""),
      format:
        appId === "opencode"
          ? "@ai-sdk/google"
          : appId === "openclaw"
            ? "google-generative-ai"
            : "chat_completions",
    },
    {
      appId,
      name: "Grok",
      baseUrl: "https://api.x.ai/v1",
      format:
        appId === "opencode"
          ? "@ai-sdk/openai"
          : appId === "openclaw"
            ? "openai-responses"
            : "codex_responses",
    },
  ]),
  ...(
    ["claude", "codex", "gemini", "opencode", "openclaw", "hermes"] as const
  ).flatMap((appId) =>
    (
      [
        ["Token-AI", "https://tken.lol"],
        ["MX-AI", "https://mxzzz.xyz"],
      ] as const
    ).map(([name, origin]) => ({
      appId,
      name,
      baseUrl: origin + (appId === "gemini" ? "" : "/v1"),
      format:
        appId === "gemini"
          ? undefined
          : appId === "opencode"
            ? "@ai-sdk/openai"
            : appId === "openclaw"
              ? "openai-responses"
              : appId === "hermes"
                ? "codex_responses"
                : "openai_responses",
    })),
  ),
];

describe("official and featured presets in the shared provider form", () => {
  it.each(cases)(
    "$appId / $name saves the selected API configuration",
    async ({ appId, name, baseUrl, format, keyField }) => {
      const onSubmit = vi.fn();
      const { container } = render(
        <QueryClientProvider client={createTestQueryClient()}>
          <ProviderForm
            appId={appId}
            submitLabel="save-provider"
            onSubmit={onSubmit}
            onCancel={() => {}}
          />
        </QueryClientProvider>,
      );
      fireEvent.click(
        screen.getByText(name, { selector: "span" }).closest("button")!,
      );
      const apiKey = screen.getByLabelText("API Key");
      expect(apiKey).toHaveValue("");
      fireEvent.change(apiKey, { target: { value: "sk-official-test" } });
      const providerKey = container.querySelector(`#${appId}-key`);
      if (providerKey)
        fireEvent.change(providerKey, { target: { value: "official-test" } });
      fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const submitted = onSubmit.mock.calls[0][0];
      const config = JSON.parse(submitted.settingsConfig);
      expect(submitted.name).toBe(name);
      expect(submitted.presetCategory).toBe("third_party");
      expect(submitted.meta?.providerType).toBeUndefined();
      expect(submitted.meta?.authBinding).toBeUndefined();
      if (appId === "claude") {
        expect(config.env).toMatchObject({
          ANTHROPIC_BASE_URL: baseUrl,
          [keyField ?? "ANTHROPIC_AUTH_TOKEN"]: "sk-official-test",
        });
        expect(submitted.meta.apiFormat).toBe(format);
        if (keyField) expect(submitted.meta.apiKeyField).toBe(keyField);
      } else if (appId === "codex") {
        const toml = parseToml(config.config) as any;
        expect(toml.model_providers[toml.model_provider]).toMatchObject({
          base_url: baseUrl,
          wire_api: "responses",
        });
        expect(config.auth.OPENAI_API_KEY).toBe("sk-official-test");
        expect(submitted.meta.apiFormat).toBe(format);
        if (keyField) expect(submitted.meta.apiKeyField).toBe(keyField);
      } else if (appId === "gemini") {
        expect(config.env).toMatchObject({
          GOOGLE_GEMINI_BASE_URL: baseUrl,
          GEMINI_API_KEY: "sk-official-test",
          GEMINI_MODEL: "gemini-3.6-flash",
        });
      } else if (appId === "opencode") {
        expect(config).toMatchObject({
          npm: format,
          options: { baseURL: baseUrl, apiKey: "sk-official-test" },
        });
      } else if (appId === "openclaw") {
        expect(config).toMatchObject({
          api: format,
          baseUrl,
          apiKey: "sk-official-test",
        });
        if (["OpenAI", "Claude", "Gemini", "Grok"].includes(name)) {
          const primary = submitted.suggestedDefaults?.model?.primary;
          expect(primary).toBe(`official-test/${config.models[0].id}`);
        }
      } else if (appId === "hermes") {
        expect(config).toMatchObject({
          api_mode: format,
          base_url: baseUrl,
          api_key: "sk-official-test",
        });
      }
    },
  );
});
