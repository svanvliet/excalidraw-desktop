import { describe, it, expect } from "vitest";

describe("test harness", () => {
  it("runs vitest with jsdom + jest-dom matchers wired up", () => {
    const div = document.createElement("div");
    div.textContent = "hello";
    expect(div).toHaveTextContent("hello");
  });
});
