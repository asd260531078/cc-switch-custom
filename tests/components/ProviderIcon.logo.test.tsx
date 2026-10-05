import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ProviderIconBox } from "@/components/ProviderIconBox";
import { getIconUrl } from "@/icons/extracted";

const logoHook = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useProviderLogo", () => ({
  useProviderLogo: logoHook,
}));

const SAFE_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSafe";
const SECOND_SAFE_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSecond";

describe("ProviderIcon website logo", () => {
  beforeEach(() => {
    logoHook.mockReset();
  });

  it("waits for a safe cached data URI and never renders the remote URL", () => {
    logoHook.mockReturnValue(undefined);
    const { rerender } = render(
      <ProviderIcon
        icon="openai"
        iconUrl="https://cdn.example.com/logo.png"
        name="Example"
        size={24}
      />,
    );

    expect(logoHook).toHaveBeenCalledWith("https://cdn.example.com/logo.png");
    expect(screen.queryByRole("img", { name: "Example" })).toBeNull();
    expect(
      document.querySelector('img[src="https://cdn.example.com/logo.png"]'),
    ).toBeNull();

    logoHook.mockReturnValue(SAFE_LOGO);
    rerender(
      <ProviderIcon
        icon="openai"
        iconUrl="https://cdn.example.com/logo.png"
        name="Example"
        size={24}
      />,
    );

    expect(screen.getByRole("img", { name: "Example" })).toHaveAttribute(
      "src",
      SAFE_LOGO,
    );
  });

  it("falls back to the built-in icon after cache/load failure or image error", () => {
    logoHook.mockReturnValue(undefined);
    const { rerender } = render(
      <ProviderIcon
        icon="openai"
        iconUrl="https://cdn.example.com/logo.png"
        name="Example"
      />,
    );

    expect(screen.getByTitle("Example").tagName).toBe("SPAN");

    logoHook.mockReturnValue(SAFE_LOGO);
    rerender(
      <ProviderIcon
        icon="openai"
        iconUrl="https://cdn.example.com/logo.png"
        name="Example"
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Example" }));

    expect(screen.queryByRole("img", { name: "Example" })).toBeNull();
    expect(screen.getByTitle("Example").tagName).toBe("SPAN");
  });

  it("loads a logo through the shared icon box and preserves its fallback sizing", () => {
    logoHook.mockReturnValue(SAFE_LOGO);
    const iconUrl = "https://cdn.example.com/Logo%2FOriginal.png?Sig=MiXeD";
    const { container } = render(
      <ProviderIconBox icon="openai" iconUrl={iconUrl} name="Example" />,
    );
    const box = container.firstElementChild;
    const logo = container.querySelector("img")!;
    expect(logoHook).toHaveBeenCalledWith(iconUrl);
    expect(logo).toHaveAttribute("src", SAFE_LOGO);
    expect(logo.style.width).toBe("22px");
    fireEvent.error(logo);
    expect(container.querySelector("img")).toBeNull();
    expect(container.firstElementChild).toBe(box);
    expect(container.querySelector('[title="Example"]')).toHaveStyle({
      width: "22px",
      height: "22px",
    });
  });

  it("retains the tile icon when a remote logo fails inside the shared box", () => {
    logoHook.mockReturnValue(SAFE_LOGO);
    const { container } = render(
      <ProviderIconBox
        icon="88api"
        iconUrl="https://cdn.example.com/tile.png"
        name="Example"
      />,
    );
    const box = container.firstElementChild;
    fireEvent.error(container.querySelector("img")!);
    const fallback = container.querySelector("img")!;
    expect(fallback).toHaveAttribute("src", getIconUrl("88api"));
    expect(fallback.style.width).toBe("32px");
    expect(fallback.className).toContain("object-cover");
    expect(container.firstElementChild).toBe(box);
  });

  it("allows a replacement URL after the previous logo failed", () => {
    logoHook.mockReturnValue(SAFE_LOGO);
    const { rerender } = render(
      <ProviderIcon
        icon="openai"
        iconUrl="https://cdn.example.com/first.png"
        name="Example"
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Example" }));

    logoHook.mockReturnValue(SECOND_SAFE_LOGO);
    rerender(
      <ProviderIcon
        icon="openai"
        iconUrl="https://cdn.example.com/second.png"
        name="Example"
      />,
    );

    expect(logoHook).toHaveBeenLastCalledWith(
      "https://cdn.example.com/second.png",
    );
    expect(screen.getByRole("img", { name: "Example" })).toHaveAttribute(
      "src",
      SECOND_SAFE_LOGO,
    );
  });
});
