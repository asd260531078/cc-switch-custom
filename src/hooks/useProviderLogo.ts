import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const PNG_PREFIX = "data:image/png;base64,";
const MAX_DATA_URL_LENGTH = PNG_PREFIX.length + Math.ceil((512 * 1024) / 3) * 4;
const cache = new Map<
  string,
  { expiresAt: number; promise: Promise<string | undefined> }
>();

function validLogoUrl(value?: string): value is string {
  if (
    !value ||
    Array.from(value).length > 2048 ||
    /[\s\u0000-\u001f\u007f\\]/.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !value.split("://")[1]?.split(/[/?#]/)[0].includes("@")
    );
  } catch {
    return false;
  }
}

function loadLogo(iconUrl: string): Promise<string | undefined> {
  const existing = cache.get(iconUrl);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;

  // Share in-flight loads by the exact URL; API endpoints never enter this cache.
  const entry = {
    expiresAt: Infinity,
    promise: Promise.resolve<string | undefined>(undefined),
  };
  entry.promise = invoke<string | null>("get_provider_logo", { iconUrl })
    .then((data) => {
      if (
        typeof data !== "string" ||
        data.length > MAX_DATA_URL_LENGTH ||
        !data.startsWith(`${PNG_PREFIX}iVBORw0KGgo`) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data.slice(PNG_PREFIX.length))
      ) {
        return undefined;
      }
      return data;
    })
    .catch(() => undefined)
    .then((data) => {
      entry.expiresAt = Date.now() + (data ? 5 * 60_000 : 60_000);
      return data;
    });
  cache.delete(iconUrl);
  cache.set(iconUrl, entry);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return entry.promise;
}

/** Only sanitized local PNG data reaches the WebView; it never fetches iconUrl. */
export function useProviderLogo(iconUrl?: string): string | undefined {
  const [loaded, setLoaded] = useState<{ url: string; data?: string }>();

  useEffect(() => {
    if (!validLogoUrl(iconUrl)) return;
    let active = true;
    // Avoid a network request for every keystroke in the shared provider editor.
    const timer = setTimeout(() => {
      void loadLogo(iconUrl).then((data) => {
        if (active) setLoaded({ url: iconUrl, data });
      });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [iconUrl]);

  return loaded?.url === iconUrl ? loaded?.data : undefined;
}
