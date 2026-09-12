import type { ProviderCategory } from "@/types";
import { getFeaturedProviderPriority } from "./featuredProviderSites";

// Some direct integrations use a client-relative "third_party" category.
// Keep their existing categories: they also control authentication and forms.
const officialProviderHosts = new Set([
  "openai.com",
  "chatgpt.com",
  "ai.google.dev",
  "github.com",
  "x.ai",
  "build.nvidia.com",
]);

export function isVisibleProviderPreset(preset: {
  category?: ProviderCategory;
  websiteUrl?: string;
}): boolean {
  if (getFeaturedProviderPriority(preset) >= 0) return true;

  switch (preset.category) {
    case "official":
    case "cn_official":
    case "cloud_provider":
      return true;
    // These configure local agents, rather than a provider service.
    case "omo":
    case "omo-slim":
      return true;
    default:
      try {
        return officialProviderHosts.has(
          new URL(preset.websiteUrl ?? "").hostname,
        );
      } catch {
        return false;
      }
  }
}
