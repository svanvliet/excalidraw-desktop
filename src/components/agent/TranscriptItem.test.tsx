import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TranscriptItem } from "../../stores/agentStore";
import { ToolGroup, TranscriptItemView, permissionSummary } from "./TranscriptItem";
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

describe("permission card", () => {
  const script = 'cd /tmp\necho "hi"\nls -la';
  const card = (title: string, detail: string | null): TranscriptItem => ({
    kind: "permission",
    id: "r1",
    turnId: "T1",
    toolName: "shell",
    title,
    detail,
    decision: null,
  });

  it("titles a multi-line command with its first line and shows the command once", () => {
    render(
      <TranscriptItemView
        item={card(script, JSON.stringify({ command: script }))}
        engine="copilot"
        streaming={false}
        onPermission={() => {}}
        onRevert={() => {}}
        onRetry={() => {}}
      />,
    );
    const heading = screen.getByText("cd /tmp");
    expect(heading).toHaveAttribute("title", script);
    expect(screen.getByTestId("agent-permission-detail").textContent).toBe(script);
    expect(screen.getByRole("button", { name: "Allow all for this conversation" })).toBeTruthy();
  });

  it("keeps a plain detail and falls back to the full title when there is none", () => {
    expect(permissionSummary("Create an issue", "octo/repo")).toEqual({
      heading: "Create an issue",
      body: "octo/repo",
    });
    expect(permissionSummary(script, null)).toEqual({ heading: "cd /tmp", body: script });
    expect(permissionSummary("Run ls", null)).toEqual({ heading: "Run ls", body: null });
  });
});
