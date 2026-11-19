/**
 * Subscribe to AI agent events from Rust (docs/ai-integration.md). Mirrors collabEvents.ts.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AGENT_EVENT, AGENT_TOOL_CALL_EVENT, isTauri } from "./commands";
import type { AgentEventEnvelope, ToolCallRequest } from "../agent/types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

export function isAgentEventEnvelope(v: unknown): v is AgentEventEnvelope {
  return (
    isRecord(v) &&
    typeof v.sessionId === "string" &&
    typeof v.tabId === "string" &&
    isRecord(v.event) &&
    typeof v.event.type === "string"
  );
}

export function isToolCallRequest(v: unknown): v is ToolCallRequest {
  return (
    isRecord(v) &&
    typeof v.callId === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.tabId === "string" &&
    typeof v.tool === "string" &&
    isRecord(v.args)
  );
}

export async function onAgentEvent(handler: (e: AgentEventEnvelope) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>(AGENT_EVENT, (event) => {
    if (isAgentEventEnvelope(event.payload)) handler(event.payload);
  });
}

export async function onAgentToolCall(
  handler: (req: ToolCallRequest) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>(AGENT_TOOL_CALL_EVENT, (event) => {
    if (isToolCallRequest(event.payload)) handler(event.payload);
  });
}
