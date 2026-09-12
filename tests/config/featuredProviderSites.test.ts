import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { featuredProviderSites } from "@/config/featuredProviderSites";
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
import {
  getVisiblePresetEntries,
  type AnyPreset,
} from "@/components/providers/forms/ProviderPresetSelector";
import {
  getIconMetadata,
  getIconUrl,
  hasIcon,
  isUrlIcon,
} from "@/icons/extracted";

const catalogs: [string, AnyPreset[]][] = [
  ["Claude Code", providerPresets],
  ["Claude Desktop", claudeDesktopProviderPresets],
  ["Codex", codexProviderPresets],
  ["Gemini", geminiProviderPresets],
  ["OpenCode", opencodeProviderPresets],
  ["OpenClaw", openclawProviderPresets],
  ["Hermes", hermesProviderPresets],
  ["Pi", piProviderPresets],
  ["Grok Build", [grokBuildOfficialPreset, ...grokBuildProviderPresets]],
];

function findPreset<T extends { name: string }>(presets: T[], name: string): T {
  const preset = presets.find((item) => item.name === name);
  if (!preset) throw new Error(`Missing preset: ${name}`);
  return preset;
}

describe("featured provider sites", () => {
  it.each(catalogs)(
    "%s pins Token-AI and MX-AI in that order without changing preset IDs",
    (_, presets) => {
      const entries = presets.map((preset, index) => ({
        id: String(index),
        preset,
      }));
      const before = [...entries];
      for (const sortMode of ["original", "nameAsc"] as const) {
        const visible = getVisiblePresetEntries(entries, {
          query: "",
          sortMode,
          t: (key) => key,
        });
        expect(visible.slice(0, 2).map((entry) => entry.preset.name)).toEqual([
          "Token-AI",
          "MX-AI",
        ]);
        for (const entry of visible.slice(0, 2)) {
          expect(entry).toBe(entries[Number(entry.id)]);
          expect(entry.preset.category).toBe("third_party");
          expect(entry.preset.isPartner).not.toBe(true);
        }
        expect(visible.some((entry) => entry.preset.name === "PackyCode")).toBe(
          false,
        );
        const searched = getVisiblePresetEntries(entries, {
          query: "MX-AI",
          sortMode,
          t: (key) => key,
        });
        expect(searched.map((entry) => entry.preset.name)).toEqual(["MX-AI"]);
      }
      expect(entries).toEqual(before);
    },
  );

  it.each([
    ["Token-AI", "https://tken.lol"],
    ["MX-AI", "https://mxzzz.xyz"],
  ])(
    "%s uses the requested website origin for every app, with the appropriate API path",
    (name, origin) => {
      const site = featuredProviderSites.find(
        (item) => item.preset.name === name,
      )!;
      expect(site.apiBaseUrl).toBe(origin);
      expect(site.preset.websiteUrl).toBe(origin);
      const claude = findPreset(providerPresets, name).settingsConfig as {
        env: Record<string, string>;
      };
      expect(claude.env).toEqual({
        ANTHROPIC_BASE_URL: origin,
        ANTHROPIC_AUTH_TOKEN: "",
      });
      expect(findPreset(claudeDesktopProviderPresets, name).baseUrl).toBe(
        origin,
      );
      const codex = findPreset(codexProviderPresets, name);
      const codexConfig = parseToml(codex.config!) as any;
      expect(codexConfig.model_providers.custom).toMatchObject({
        base_url: origin + "/v1",
        wire_api: "responses",
        requires_openai_auth: false,
      });
      expect(codex.auth).toEqual({ OPENAI_API_KEY: "" });
      const gemini = findPreset(geminiProviderPresets, name);
      expect(gemini.baseURL).toBe(origin);
      expect((gemini.settingsConfig as any).env).toMatchObject({
        GOOGLE_GEMINI_BASE_URL: origin,
        GEMINI_API_KEY: "",
      });
      expect(
        findPreset(opencodeProviderPresets, name).settingsConfig.options
          .baseURL,
      ).toBe(origin + "/v1");
      expect(
        findPreset(openclawProviderPresets, name).settingsConfig.baseUrl,
      ).toBe(origin);
      expect(
        findPreset(hermesProviderPresets, name).settingsConfig.base_url,
      ).toBe(origin);
      expect(findPreset(piProviderPresets, name).settingsConfig.baseUrl).toBe(
        origin,
      );
      const grok = parseToml(
        findPreset(grokBuildProviderPresets, name).config!,
      ) as any;
      expect(grok.model_providers.custom.base_url).toBe(origin + "/v1");
    },
  );

  it("bundles the original site logos and exposes searchable display names", () => {
    for (const site of featuredProviderSites) {
      const icon = site.preset.icon;
      expect(hasIcon(icon)).toBe(true);
      expect(isUrlIcon(icon)).toBe(true);
      expect(getIconUrl(icon)).toContain(icon + ".webp");
      expect(getIconUrl(icon)).not.toMatch(/^https?:/);
      expect(getIconMetadata(icon)?.displayName).toBe(site.preset.name);
    }
  });
});
