// Names and logos verified against each site's public /api/status.
// API addresses use the website domains explicitly requested by the user.
// API roots omit /v1; adapters that need a versioned base add it explicitly.
export const featuredProviderSites = [
  {
    key: "token-ai",
    apiBaseUrl: "https://tken.lol",
    preset: {
      name: "Token-AI",
      websiteUrl: "https://tken.lol",
      category: "third_party" as const,
      icon: "token-ai",
    },
  },
  {
    key: "mx-ai",
    apiBaseUrl: "https://mxzzz.xyz",
    preset: {
      name: "MX-AI",
      websiteUrl: "https://mxzzz.xyz",
      category: "third_party" as const,
      icon: "mx-ai",
    },
  },
];

export function getFeaturedProviderPriority(preset: {
  websiteUrl?: string;
}): number {
  const websiteUrl = preset.websiteUrl?.replace(/\/+$/, "");
  return featuredProviderSites.findIndex(
    (site) => site.preset.websiteUrl === websiteUrl,
  );
}
