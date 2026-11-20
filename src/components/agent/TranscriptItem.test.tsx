import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TranscriptItem } from "../../stores/agentStore";
import { ToolGroup } from "./TranscriptItem";
import { groupTranscript } from "./transcriptGroups";

const tool = (id: string, status = "completed") =>
  ({
    kind: "tool",
    id,
    name: `excalidraw-${id}`,
    title: null,
    source: "canvas",
    status,
  }) as unknown as TranscriptItem;
const text = (id: string) =>
  ({ kind: "assistant", id, turnId: "T", text: id, thinking: "" }) as unknown as TranscriptItem;

describe("groupTranscript", () => {
  it("folds each run of consecutive tool calls into its own group, in order", () => {
    const entries = groupTranscript([text("a"), tool("t1"), tool("t2"), text("b"), tool("t3")]);
    expect(entries.map((e) => (e.kind === "tools" ? e.items.map((t) => t.id) : e.item.id))).toEqual(
      ["a", ["t1", "t2"], "b", ["t3"]],
    );
  });
});

describe("ToolGroup", () => {
  it("summarizes count, running state and failures, collapsed by default", () => {
    const items = [tool("t1"), tool("t2", "failed"), tool("t3", "running")] as Extract<
      TranscriptItem,
      { kind: "tool" }
    >[];
    render(<ToolGroup items={items} engine="copilot" />);
    const group = screen.getByTestId("agent-tool-group");
    expect(group.hasAttribute("open")).toBe(false);
    expect(group.querySelector("summary")?.textContent).toBe("Running tools (3) · 1 failed");
    expect(screen.getAllByTestId("agent-tool")).toHaveLength(3);
  });
});
