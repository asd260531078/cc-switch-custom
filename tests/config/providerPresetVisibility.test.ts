import { describe, expect, it } from "vitest";
import { providerPresets } from "@/config/claudeProviderPresets";
import { claudeDesktopProviderPresets } from "@/config/claudeDesktopProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import { openclawProviderPresets } from "@/config/openclawProviderPresets";
import { hermesProviderPresets } from "@/config/hermesProviderPresets";
import { piProviderPresets } from "@/config/piProviderPresets";
import {
  grokBuildOfficialPreset,
  grokBuildProviderPresets,
} from "@/config/grokBuildProviderPresets";
import { isVisibleProviderPreset } from "@/config/providerPresetVisibility";
import {
  getVisiblePresetEntries,
  type AnyPreset,
} from "@/components/providers/forms/ProviderPresetSelector";

const directNames = ["OpenAI", "Claude", "Gemini", "Grok"];
const catalogs: [string, AnyPreset[], string[]][] = [
  [
    "Claude Code",
    providerPresets,
    ["Claude Official", "OpenAI", "Claude", "Gemini Native", "Grok"],
  ],
  [
    "Claude Desktop",
    claudeDesktopProviderPresets,
    ["Claude Desktop Official", "OpenAI", "Claude", "Gemini Native", "Grok"],
  ],
  [
    "Codex",
    codexProviderPresets,
    ["OpenAI Official", "OpenAI", "Claude", "Gemini", "xAI (Grok)"],
  ],
  ["Gemini", geminiProviderPresets, ["Google Official", "Gemini"]],
  ["OpenCode", opencodeProviderPresets, directNames],
  ["OpenClaw", openclawProviderPresets, directNames],
  ["Hermes", hermesProviderPresets, directNames],
  ["Pi", piProviderPresets, directNames],
  [
    "Grok Build",
    [grokBuildOfficialPreset, ...grokBuildProviderPresets],
    ["Grok Official", "OpenAI", "Claude", "Gemini", "xAI (Grok)"],
  ],
];

describe("official provider preset visibility", () => {
  it.each(catalogs)(
    "%s keeps official presets and excludes relay presets without changing IDs or stored templates",
    (_, presets, officialNames) => {
      const entries = presets.map((preset, index) => ({
        id: String(index),
        preset,
      }));
      const original = JSON.stringify(entries);
      for (const sortMode of ["original", "nameAsc"] as const) {
        const visible = getVisiblePresetEntries(entries, {
          query: "",
          sortMode,
          t: (key) => key,
        });
        for (const officialName of officialNames) {
          expect(
            visible.some((entry) => entry.preset.name === officialName),
            officialName,
          ).toBe(true);
          expect(
            getVisiblePresetEntries(entries, {
              query: officialName,
              sortMode,
              t: (key) => key,
            }).some((entry) => entry.preset.name === officialName),
            officialName,
          ).toBe(true);
        }
        const relay = presets.find((preset) => preset.name === "PackyCode");
        expect(relay).toBeDefined();
        expect(visible.some((entry) => entry.preset === relay)).toBe(false);
        for (const entry of visible) {
          expect(entries[Number(entry.id)]).toBe(entry);
        }
        expect(
          getVisiblePresetEntries(entries, {
            query: "PackyCode",
            sortMode,
            t: (key) => key,
          }),
        ).toEqual([]);
      }
      expect(JSON.stringify(entries)).toBe(original);
    },
  );

  it("keeps direct official integrations whose category is relative to the client", () => {
    for (const name of [
      "Codex",
      "GitHub Copilot",
      "Gemini Native",
      "xAI (Grok)",
      "Nvidia",
    ]) {
      const preset = providerPresets.find((item) => item.name === name);
      expect(preset, name).toBeDefined();
      expect(isVisibleProviderPreset(preset!), name).toBe(true);
    }
    for (const name of [
      "AWS Bedrock",
      "Oh My OpenCode",
      "Oh My OpenCode Slim",
    ]) {
      const preset = opencodeProviderPresets.find((item) => item.name === name);
      expect(preset, name).toBeDefined();
      expect(isVisibleProviderPreset(preset!), name).toBe(true);
    }
  });

  it("excludes uncategorized relays and does not mistake names or URL substrings for official integrations", () => {
    const relay = codexProviderPresets.find(
      (preset) => preset.name === "AICodeMirror",
    );
    expect(relay).toBeDefined();
    expect(isVisibleProviderPreset(relay!)).toBe(false);
    for (const websiteUrl of [
      undefined,
      "",
      "invalid",
      "https://openai.com.example.org",
      "https://example.org/openai.com",
    ]) {
      expect(isVisibleProviderPreset({ websiteUrl })).toBe(false);
    }
  });
});
