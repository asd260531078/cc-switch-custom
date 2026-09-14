import { describe, expect, it } from "vitest";
import { hermesProviderPresets } from "@/config/hermesProviderPresets";
import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import { openclawProviderPresets } from "@/config/openclawProviderPresets";
import { isVisibleProviderPreset } from "@/config/providerPresetVisibility";
import type { ProviderCategory } from "@/types";

const officialNames = ["OpenAI", "Claude", "Gemini", "Grok"] as const;
const featuredNames = ["Token-AI", "MX-AI"] as const;
const visibleCatalogs: Array<
  Array<{
    name: string;
    category?: ProviderCategory;
    websiteUrl?: string;
    isOfficial?: boolean;
  }>
> = [opencodeProviderPresets, openclawProviderPresets, hermesProviderPresets];

function findPreset<T extends { name: string }>(presets: T[], name: string): T {
  const preset = presets.find((item) => item.name === name);
  if (!preset) throw new Error(`Missing preset: ${name}`);
  return preset;
}

describe("official API-key presets for OpenCode, OpenClaw, and Hermes", () => {
  it("keeps every direct official preset visible without login semantics", () => {
    for (const presets of visibleCatalogs) {
      for (const name of officialNames) {
        const preset = findPreset(presets, name);
        expect(preset.category, name).toBe("third_party");
        expect(preset.isOfficial, name).not.toBe(true);
        expect(isVisibleProviderPreset(preset), name).toBe(true);
      }
    }
  });

  it("uses each OpenCode provider's native wire adapter and API root", () => {
    const expected = {
      OpenAI: ["@ai-sdk/openai", "https://api.openai.com/v1"],
      Claude: ["@ai-sdk/anthropic", "https://api.anthropic.com/v1"],
      Gemini: [
        "@ai-sdk/google",
        "https://generativelanguage.googleapis.com/v1beta",
      ],
      Grok: ["@ai-sdk/openai", "https://api.x.ai/v1"],
    } as const;

    for (const name of officialNames) {
      const preset = findPreset(opencodeProviderPresets, name);
      expect(
        [preset.settingsConfig.npm, preset.settingsConfig.options.baseURL],
        name,
      ).toEqual(expected[name]);
      expect(preset.settingsConfig.options.apiKey, name).toBe("");
      expect(
        Object.keys(preset.settingsConfig.models).length,
        name,
      ).toBeGreaterThan(0);
    }
  });

  it("uses native OpenClaw protocols and versioned API roots", () => {
    const expected = {
      OpenAI: ["openai-responses", "https://api.openai.com/v1"],
      Claude: ["anthropic-messages", "https://api.anthropic.com"],
      Gemini: [
        "google-generative-ai",
        "https://generativelanguage.googleapis.com/v1beta",
      ],
      Grok: ["openai-responses", "https://api.x.ai/v1"],
    } as const;

    for (const name of officialNames) {
      const preset = findPreset(openclawProviderPresets, name);
      expect(
        [preset.settingsConfig.api, preset.settingsConfig.baseUrl],
        name,
      ).toEqual(expected[name]);
      expect(preset.settingsConfig.apiKey, name).toBe("");
      expect(preset.settingsConfig.models?.length, name).toBeGreaterThan(0);
    }
  });

  it("uses Hermes-supported modes, including Gemini's OpenAI-compatible route", () => {
    const expected = {
      OpenAI: ["codex_responses", "https://api.openai.com/v1"],
      Claude: ["anthropic_messages", "https://api.anthropic.com"],
      Gemini: [
        "chat_completions",
        "https://generativelanguage.googleapis.com/v1beta/openai/",
      ],
      Grok: ["codex_responses", "https://api.x.ai/v1"],
    } as const;

    for (const name of officialNames) {
      const preset = findPreset(hermesProviderPresets, name);
      expect(
        [preset.settingsConfig.api_mode, preset.settingsConfig.base_url],
        name,
      ).toEqual(expected[name]);
      expect(preset.settingsConfig.api_key, name).toBe("");
      expect(preset.settingsConfig.models?.length, name).toBeGreaterThan(0);
    }
  });

  it("defaults Token-AI and MX-AI to Responses in all three clients", () => {
    for (const name of featuredNames) {
      const opencode = findPreset(opencodeProviderPresets, name);
      expect(opencode.settingsConfig.npm, name).toBe("@ai-sdk/openai");
      expect(opencode.settingsConfig.options.baseURL, name).toMatch(/\/v1$/);
      expect(opencode.settingsConfig.options.apiKey, name).toBe("");

      const openclaw = findPreset(openclawProviderPresets, name);
      expect(openclaw.settingsConfig.api, name).toBe("openai-responses");
      expect(openclaw.settingsConfig.baseUrl, name).toMatch(/\/v1$/);
      expect(openclaw.settingsConfig.apiKey, name).toBe("");

      const hermes = findPreset(hermesProviderPresets, name);
      expect(hermes.settingsConfig.api_mode, name).toBe("codex_responses");
      expect(hermes.settingsConfig.base_url, name).toMatch(/\/v1$/);
      expect(hermes.settingsConfig.api_key, name).toBe("");
    }
  });
});
