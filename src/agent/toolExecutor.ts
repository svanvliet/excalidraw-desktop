/**
 * Bridges Rust's `agent://tool-call` events to the webview scene tools and returns results
 * through `agent_tool_result` (docs/ai-integration.md § Tool execution). Never throws: every
 * failure becomes an `isError` MCP result the model can read and recover from.
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import { log } from "../lib/logger";
import { onAgentToolCall } from "../ipc/agentEvents";
import { agentToolResult } from "../ipc/commands";
import { runSceneTool, ToolError } from "./sceneTools";
import type { ToolCallRequest, ToolCallResult } from "./types";

export async function executeToolCall(req: ToolCallRequest): Promise<ToolCallResult> {
  try {
    const content = await runSceneTool(req.tool, req.args, req.tabId || undefined);
    return { callId: req.callId, isError: false, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof ToolError)) log.error(`agent tool ${req.tool} crashed`, err);
    return {
      callId: req.callId,
      isError: true,
      content: [{ type: "text", text: `Error: ${message}` }],
    };
  }
}

/** Start answering canvas tool calls. Returns the unlisten function. */
export function startToolExecutor(): Promise<UnlistenFn> {
  return onAgentToolCall((req) => {
    void executeToolCall(req).then((result) =>
      agentToolResult(result).catch((err: unknown) =>
        log.error(`agent: failed to return result for ${req.tool} (${req.callId})`, err),
      ),
    );
  });
}
