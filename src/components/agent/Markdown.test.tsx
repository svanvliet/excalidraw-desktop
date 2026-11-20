import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./Markdown";
import { isSafeUrl } from "./markdownParse";

describe("Markdown", () => {
  it("renders headings, lists, fenced code, quotes, tables and paragraphs", () => {
    const { container } = render(
      <Markdown
        text={
          "# Title\n\nSome text\n\n- a\n  - nested\n- b\n\n1. one\n2. two\n\n```js\nconst x = 1;\n```\n\n> quoted\n\n| Name | Area |\n|---|---|\n| DJ | Devices |\n\n- [x] done\n\n~~old~~"
        }
      />,
    );
    expect(container.querySelector("h3")).toHaveTextContent("Title");
    expect(container.querySelector("ul ul li")).toHaveTextContent("nested");
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("pre code")).toHaveTextContent("const x = 1;");
    expect(container.querySelector("blockquote")).toHaveTextContent("quoted");
    expect([...container.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Name",
      "Area",
    ]);
    expect([...container.querySelectorAll("td")].map((td) => td.textContent)).toEqual([
      "DJ",
      "Devices",
    ]);
    expect(container.querySelector('input[type="checkbox"]')).toBeChecked();
    expect(container.querySelector("del")).toHaveTextContent("old");
  });

  it("shows images as alt text instead of loading them", () => {
    const { container } = render(<Markdown text={"![diagram](https://example.com/x.png)"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("[diagram]");
  });

  it("renders inline formatting as elements", () => {
    const { container } = render(<Markdown text={"Use `x`, **bold** and *em*."} />);
    expect(container.querySelector("code")).toHaveTextContent("x");
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("em");
  });

  it("never renders raw HTML from model output", () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror="alert(1)"> <script>alert(1)</script>'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>");
  });

  it("only links http(s) URLs", () => {
    const { container } = render(
      <Markdown text={"[ok](https://example.com) [bad](javascript:alert(1)) https://a.dev/x."} />,
    );
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://example.com", "https://a.dev/x"]);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
  });
});
