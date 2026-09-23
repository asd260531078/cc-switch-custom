import { describe, expect, it } from "vitest";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { hermesProviderPresets } from "@/config/hermesProviderPresets";
import { openclawProviderPresets } from "@/config/openclawProviderPresets";
import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import { piProviderPresets } from "@/config/piProviderPresets";
import { resolvePiThinkingProfile } from "@/config/piThinkingProfiles";

describe("new official model import presets", () => {
  it("offers exact OpenAI and Anthropic IDs on direct API presets without changing defaults", () => {
    const openaiIds = ["gpt-6-sol", "gpt-6-luna"];
    const claudeId = "claude-opus-5-5";
    const find = <T extends { name: string }>(presets: T[], name: string) => {
      const preset = presets.find((entry) => entry.name === name);
      if (!preset) throw new Error(`Missing ${name} preset`);
      return preset;
    };

    const codexOpenAI = find(codexProviderPresets, "OpenAI");
    const codexClaude = find(codexProviderPresets, "Claude");
    expect(codexOpenAI.modelCatalog?.map((model) => model.model)).toEqual(
      expect.arrayContaining(openaiIds),
    );
    expect(codexClaude.modelCatalog?.map((model) => model.model)).toContain(
      claudeId,
    );
    expect(codexOpenAI.apiFormat).toBe("openai_responses");
    expect(codexClaude.apiFormat).toBe("anthropic");
    expect(codexOpenAI.modelCatalog?.[0]?.model).toBe("gpt-5.6-sol");
    expect(codexClaude.modelCatalog?.[0]?.model).toBe("claude-sonnet-5");

    const piOpenAI = find(piProviderPresets, "OpenAI");
    const piClaude = find(piProviderPresets, "Claude");
    expect(piOpenAI.settingsConfig.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(openaiIds),
    );
    expect(piClaude.settingsConfig.models.map((model) => model.id)).toContain(
      claudeId,
    );
    for (const model of piOpenAI.settingsConfig.models.filter((entry) =>
      openaiIds.includes(entry.id),
    )) {
      expect(model.contextWindow).toBe(1_050_000);
      expect(model.maxTokens).toBe(128_000);
    }
    expect(piOpenAI.settingsConfig.api).toBe("openai-responses");
    expect(piClaude.settingsConfig.api).toBe("anthropic-messages");
    expect(piOpenAI.settingsConfig.models[0].id).toBe("gpt-5.6-sol");
    expect(piClaude.settingsConfig.models[0].id).toBe("claude-sonnet-5");

    const openCodeOpenAI = find(opencodeProviderPresets, "OpenAI");
    const openCodeClaude = find(opencodeProviderPresets, "Claude");
    expect(Object.keys(openCodeOpenAI.settingsConfig.models)).toEqual(
      expect.arrayContaining(openaiIds),
    );
    expect(openCodeClaude.settingsConfig.models).toHaveProperty(claudeId);
    expect(Object.keys(openCodeOpenAI.settingsConfig.models)[0]).toBe(
      "gpt-5.6-sol",
    );
    expect(Object.keys(openCodeClaude.settingsConfig.models)[0]).toBe(
      "claude-sonnet-5",
    );

    const openClawOpenAI = find(openclawProviderPresets, "OpenAI");
    const openClawClaude = find(openclawProviderPresets, "Claude");
    expect(
      openClawOpenAI.settingsConfig.models?.map((model) => model.id),
    ).toEqual(expect.arrayContaining(openaiIds));
    expect(
      openClawClaude.settingsConfig.models?.map((model) => model.id),
    ).toContain(claudeId);
    expect(openClawOpenAI.suggestedDefaults?.model?.primary).toBe(
      "openai/gpt-5.6-sol",
    );
    expect(openClawOpenAI.settingsConfig.models?.[0]?.id).toBe("gpt-5.6-sol");
    expect(openClawClaude.settingsConfig.models?.[0]?.id).toBe(
      "claude-sonnet-5",
    );

    const hermesOpenAI = find(hermesProviderPresets, "OpenAI");
    const hermesClaude = find(hermesProviderPresets, "Claude");
    expect(
      hermesOpenAI.settingsConfig.models?.map((model) => model.id),
    ).toEqual(expect.arrayContaining(openaiIds));
    expect(
      hermesClaude.settingsConfig.models?.map((model) => model.id),
    ).toContain(claudeId);
    expect(hermesOpenAI.settingsConfig.models?.[0]?.id).toBe("gpt-5.6-sol");
    expect(hermesClaude.settingsConfig.models?.[0]?.id).toBe("claude-sonnet-5");
  });

  it("uses compatible Pi thinking settings for the new API models", () => {
    for (const catalogKey of [
      "openai/gpt-6-sol",
      "openai/gpt-6-luna",
    ] as const) {
      const profile = resolvePiThinkingProfile({
        catalogKey,
        api: "openai-responses",
      });
      expect(profile?.map.off).toBe("none");
      expect(profile?.map.max).toBe("max");
    }
    expect(
      resolvePiThinkingProfile({
        catalogKey: "anthropic/claude-opus-5-5",
        api: "anthropic-messages",
      })?.modelCompat,
    ).toEqual({ forceAdaptiveThinking: true });
  });
});
