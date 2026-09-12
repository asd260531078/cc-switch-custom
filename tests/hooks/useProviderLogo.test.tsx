import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderLogo } from "@/hooks/useProviderLogo";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEn0AAAAASUVORK5CYII=";
const tick = () => act(() => vi.advanceTimersByTimeAsync(250));

describe("useProviderLogo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("only invokes the logo command with the original case-sensitive URL", async () => {
    invokeMock.mockResolvedValue(PNG);
    const url = "https://main.example/Logo.PNG?Sig=AbC%252FDeF+X";
    const { result } = renderHook(() => useProviderLogo(url));
    expect(result.current).toBeUndefined();
    await tick();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("get_provider_logo", {
      iconUrl: url,
    });
    expect(result.current).toBe(PNG);
  });

  it("deduplicates pending loads and reuses successful results across mounts", async () => {
    let finish!: (value: string) => void;
    invokeMock.mockReturnValue(
      new Promise<string>((resolve) => (finish = resolve)),
    );
    const url = "https://dedupe.example/Logo.PNG";
    const first = renderHook(() => useProviderLogo(url));
    const second = renderHook(() => useProviderLogo(url));
    await tick();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await act(async () => finish(PNG));
    expect(first.result.current).toBe(PNG);
    expect(second.result.current).toBe(PNG);
    first.unmount();
    second.unmount();
    const remounted = renderHook(() => useProviderLogo(url));
    await tick();
    expect(remounted.result.current).toBe(PNG);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("keeps tenant, path case and query variants in separate cache entries", async () => {
    invokeMock.mockResolvedValue(PNG);
    const urls = [
      "https://tenant-a.example/Logo.PNG?v=AbC",
      "https://tenant-b.example/Logo.PNG?v=AbC",
      "https://tenant-a.example/logo.png?v=AbC",
      "https://tenant-a.example/Logo.PNG?v=abc",
    ];
    const views = urls.map((url) => renderHook(() => useProviderLogo(url)));
    await tick();
    expect(invokeMock).toHaveBeenCalledTimes(4);
    urls.forEach((url) => {
      expect(invokeMock).toHaveBeenCalledWith("get_provider_logo", {
        iconUrl: url,
      });
    });
    views.forEach((view) => expect(view.result.current).toBe(PNG));
  });

  it("does not let an old request paint a newly selected tenant", async () => {
    let oldReply!: (value: string) => void;
    invokeMock
      .mockReturnValueOnce(
        new Promise<string>((resolve) => (oldReply = resolve)),
      )
      .mockResolvedValueOnce(null);
    const { result, rerender } = renderHook(({ url }) => useProviderLogo(url), {
      initialProps: { url: "https://race-a.example/Logo.PNG" },
    });
    await tick();
    rerender({ url: "https://race-b.example/Logo.PNG" });
    await tick();
    await act(async () => oldReply(PNG));
    expect(result.current).toBeUndefined();
  });

  it("clears a previous image immediately when its URL is removed", async () => {
    invokeMock.mockResolvedValue(PNG);
    const { result, rerender } = renderHook(
      ({ url }: { url?: string }) => useProviderLogo(url),
      {
        initialProps: { url: "https://clear.example/logo.png" } as {
          url?: string;
        },
      },
    );
    await tick();
    expect(result.current).toBe(PNG);
    rerender({ url: undefined });
    expect(result.current).toBeUndefined();
  });

  it("ignores absent and invalid optional URL values without any IPC", async () => {
    for (const url of [
      undefined,
      "",
      "bad",
      "http://example.com/a",
      "https://user:pass@example.com/a",
      "https://@example.com/a",
      "/logo.png",
      "https://example.com/" + "a".repeat(2048),
    ]) {
      const view = renderHook(() => useProviderLogo(url));
      await tick();
      expect(view.result.current).toBeUndefined();
      view.unmount();
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("falls back on IPC failure and retries after the short failure cache expires", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("cache permission denied"))
      .mockResolvedValue(PNG);
    const url = "https://retry.example/logo.png";
    const first = renderHook(() => useProviderLogo(url));
    await tick();
    expect(first.result.current).toBeUndefined();
    first.unmount();
    const second = renderHook(() => useProviderLogo(url));
    await tick();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    second.unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    const retry = renderHook(() => useProviderLogo(url));
    await tick();
    expect(retry.result.current).toBe(PNG);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("never exposes a remote URL, SVG, HTML, malformed or oversized IPC result", async () => {
    const unsafe = [
      "https://example.com/a.png",
      "data:image/svg+xml,<svg/>",
      "<script>alert(1)</script>",
      "data:image/png;base64,<img src=x>",
      PNG + "A".repeat(700_000),
    ];
    for (let i = 0; i < unsafe.length; i++) {
      invokeMock.mockResolvedValueOnce(unsafe[i]);
      const view = renderHook(() =>
        useProviderLogo(`https://unsafe-result.example/${i}`),
      );
      await tick();
      expect(view.result.current).toBeUndefined();
      view.unmount();
    }
  });

  it("debounces edits and cancels an unmounted pending timer", async () => {
    invokeMock.mockResolvedValue(PNG);
    const { rerender, unmount } = renderHook(
      ({ url }) => useProviderLogo(url),
      {
        initialProps: { url: "https://typing.example/L" },
      },
    );
    rerender({ url: "https://typing.example/Logo.PNG" });
    await tick();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("get_provider_logo", {
      iconUrl: "https://typing.example/Logo.PNG",
    });
    rerender({ url: "https://typing.example/Cancelled.PNG" });
    unmount();
    await tick();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
