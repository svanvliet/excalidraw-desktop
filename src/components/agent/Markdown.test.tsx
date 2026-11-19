import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./Markdown";
import { isSafeUrl, parseBlocks } from "./markdownParse";

describe("Markdown", () => {
  it("parses headings, lists, fenced code, quotes and paragraphs", () => {
    const blocks = parseBlocks(
      "# Title\n\nSome text\nmore\n\n- a\n- b\n\n1. one\n2. two\n\n```js\nconst x = 1;\n```\n> quoted",
    );
    expect(blocks.map((b) => b.type)).toEqual(["h", "p", "ul", "ol", "code", "quote"]);
    expect(blocks[4]).toEqual({ type: "code", lang: "js", text: "const x = 1;" });
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
