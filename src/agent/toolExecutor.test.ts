import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallRequest, ToolCallResult } from "./types";

const runSceneTool = vi.fn();
const { ToolError } = vi.hoisted(() => ({ ToolError: class ToolError extends Error {} }));
vi.mock("./sceneTools", () => ({
  runSceneTool: (...a: unknown[]) => runSceneTool(...a),
  ToolError,
}));
let handler: ((req: ToolCallRequest) => void) | null = null;
const unlisten = vi.fn();
vi.mock("../ipc/agentEvents", () => ({
  onAgentToolCall: vi.fn(async (h: (req: ToolCallRequest) => void) => {
    handler = h;
    return unlisten;
  }),
}));
const agentToolResult = vi.fn(async (_r: ToolCallResult) => {});
vi.mock("../ipc/commands", () => ({
  agentToolResult: (r: ToolCallResult) => agentToolResult(r),
}));

import { executeToolCall, startToolExecutor } from "./toolExecutor";

const req = (over: Partial<ToolCallRequest> = {}): ToolCallRequest => ({
  callId: "c1",
  sessionId: "s1",
  tabId: "tab-1",
  tool: "get_scene_summary",
  args: {},
  ...over,
});

beforeEach(() => {
  runSceneTool.mockReset();
  agentToolResult.mockClear();
  handler = null;
});

describe("executeToolCall", () => {
  it("returns tool content and forwards the default tab", async () => {
    runSceneTool.mockResolvedValue([{ type: "text", text: "ok" }]);
    await expect(executeToolCall(req())).resolves.toEqual({
      callId: "c1",
      isError: false,
      content: [{ type: "text", text: "ok" }],
    });
    expect(runSceneTool).toHaveBeenCalledWith("get_scene_summary", {}, "tab-1");
  });

  it("turns tool errors and crashes into isError results", async () => {
    runSceneTool.mockRejectedValueOnce(new ToolError("Unknown tool: nope"));
    const a = await executeToolCall(req());
    expect(a).toMatchObject({ isError: true, content: [{ text: "Error: Unknown tool: nope" }] });
    runSceneTool.mockRejectedValueOnce(new TypeError("boom"));
    const b = await executeToolCall(req());
    expect(b).toMatchObject({ isError: true, content: [{ text: "Error: boom" }] });
  });
});

describe("startToolExecutor", () => {
  it("answers tool-call events through agentToolResult", async () => {
    runSceneTool.mockResolvedValue([{ type: "text", text: "done" }]);
    const stop = await startToolExecutor();
    expect(stop).toBe(unlisten);
    handler!(req({ callId: "c9" }));
    await vi.waitFor(() => expect(agentToolResult).toHaveBeenCalledTimes(1));
    expect(agentToolResult.mock.calls[0][0]).toMatchObject({ callId: "c9", isError: false });
  });
});
