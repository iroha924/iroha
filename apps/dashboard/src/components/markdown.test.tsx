import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/markdown.js";

describe("Markdown", () => {
  it("renders headings and lists as elements, not literal markers", () => {
    render(<Markdown source={"## Problem\n\n- one\n- two"} />);

    expect(screen.getByRole("heading", { name: "Problem" }).tagName).toBe("H2");
    expect(screen.queryByText("## Problem")).toBeNull();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["one", "two"]);
  });

  it("keeps an http link but drops a javascript: scheme", () => {
    const { container } = render(
      <Markdown source={"[ok](https://example.com) and [bad](javascript:alert(1))"} />,
    );

    const link = screen.getByRole("link", { name: "ok" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    // The javascript: link renders its text but never becomes an anchor.
    expect(screen.getByText("bad")).toBeDefined();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("renders a raw HTML node as literal text, never as markup", () => {
    const { container } = render(<Markdown source={'<img src=x onerror="alert(1)">'} />);

    // No <img> element is created — the raw HTML is shown as text.
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=");
  });

  it("does not render a remote image as an <img>", () => {
    const { container } = render(
      <Markdown source={"![alt text](https://tracker.example/x.gif)"} />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("alt text")).toBeDefined();
  });

  it("preserves an ordered list's start value", () => {
    const { container } = render(<Markdown source={"5. five\n6. six"} />);

    expect(container.querySelector("ol")?.getAttribute("start")).toBe("5");
  });

  it("resolves a reference-style link's href from its definition", () => {
    render(<Markdown source={"[text][id]\n\n[id]: https://example.com"} />);

    expect(screen.getByRole("link", { name: "text" }).getAttribute("href")).toBe(
      "https://example.com",
    );
  });

  it("sanitizes a reference-style link with a javascript: definition", () => {
    const { container } = render(<Markdown source={"[text][id]\n\n[id]: javascript:alert(1)"} />);

    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("text")).toBeDefined();
  });
});
