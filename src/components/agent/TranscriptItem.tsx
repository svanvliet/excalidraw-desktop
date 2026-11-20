/**
 * Renders one transcript entry of an agent conversation
 * (docs/ai-integration.md § UX: tool chips, permission cards, revert).
 */
import type { EngineKind, PermissionDecision, StopReason } from "../../agent/types";
import type { TranscriptItem } from "../../stores/agentStore";
import { ENGINE_META, errorGuidance, toolLabel } from "./engineMeta";
import { Markdown } from "./Markdown";
import { isSafeUrl } from "./markdownParse";
import { log } from "../../lib/logger";
import { RefreshIcon, UndoIcon } from "../icons";

import type { ToolItem } from "./transcriptGroups";

export function ToolGroup({ items, engine }: { items: ToolItem[]; engine: EngineKind | null }) {
  const active = items.filter((t) => t.status === "running" || t.status === "pending").length;
  const failed = items.filter((t) => t.status === "failed").length;
  const noun = items.length === 1 ? "tool call" : "tool calls";
  const summary = active > 0 ? `Running tools (${items.length})` : `${items.length} ${noun}`;
  return (
    <details
      className="agent-tool-group"
      data-active={active > 0 || undefined}
      data-testid="agent-tool-group"
    >
      <summary>
        <span className="agent-tool__dot" aria-hidden="true" />
        {summary}
        {failed > 0 ? <span className="agent-tool__failed"> · {failed} failed</span> : null}
      </summary>
      <div className="agent-tool-group__list">
        {items.map((t) => (
          <ToolRow key={t.id} item={t} engine={engine} />
        ))}
      </div>
    </details>
  );
}

function ToolRow({ item, engine }: { item: ToolItem; engine: EngineKind | null }) {
  const label = toolLabel(item.name, item.title);
  const source =
    item.source === "host"
      ? `${engine ? ENGINE_META[engine].label : "Agent"} tool`
      : item.source === "builtin"
        ? "Built-in tool"
        : null;
  return (
    <div
      className="agent-tool"
      data-source={item.source}
      data-status={item.status}
      data-testid="agent-tool"
    >
      <span className="agent-tool__dot" aria-hidden="true" />
      <span className="agent-tool__label">{label}</span>
      {source ? (
        <span className="agent-tool__source" title={item.name}>
          {source}: {item.name}
        </span>
      ) : null}
      {item.status === "failed" ? <span className="agent-tool__failed">failed</span> : null}
    </div>
  );
}

export interface TranscriptItemProps {
  item: TranscriptItem;
  engine: EngineKind | null;
  streaming: boolean;
  onPermission: (requestId: string, decision: PermissionDecision) => void;
  onRevert: (turnId: string, force?: boolean) => void;
  onRetry: () => void;
}

const STOP_TEXT: Record<StopReason, string | null> = {
  endTurn: null,
  cancelled: "Stopped",
  maxTurns: "Stopped — reached the turn limit",
  refusal: "The agent declined this request",
  error: "Turn ended with an error",
};

const DECISION_TEXT: Record<PermissionDecision | "expired", string> = {
  allowOnce: "Allowed once",
  allowForConversation: "Allowed for this conversation",
  deny: "Denied",
  expired: "No longer needed",
};

function openExternal(url: string) {
  if (!isSafeUrl(url)) return;
  import("@tauri-apps/plugin-opener")
    .then((m) => m.openUrl(url))
    .catch((err) => log.warn("agent: failed to open link", err));
}

export function TranscriptItemView({
  item,
  engine,
  streaming,
  onPermission,
  onRevert,
  onRetry,
}: TranscriptItemProps) {
  switch (item.kind) {
    case "user":
      return (
        <div className="agent-msg agent-msg--user" data-testid="agent-msg-user">
          {item.text}
        </div>
      );

    case "assistant":
      return (
        <div className="agent-msg agent-msg--assistant" data-testid="agent-msg-assistant">
          {item.thinking ? (
            <details className="agent-thinking">
              <summary>Thinking</summary>
              <p>{item.thinking}</p>
            </details>
          ) : null}
          {item.text ? <Markdown text={item.text} /> : null}
          {streaming ? <span className="agent-cursor" aria-hidden="true" /> : null}
        </div>
      );

    case "tool":
      return <ToolRow item={item} engine={engine} />;

    case "permission":
      return (
        <div
          className="agent-card agent-card--permission"
          role="group"
          aria-label="Permission request"
          data-testid="agent-permission"
        >
          <strong>{item.title}</strong>
          {item.detail ? <p className="agent-card__detail">{item.detail}</p> : null}
          <span className="agent-card__meta">{item.toolName}</span>
          {item.decision === null ? (
            <div className="agent-card__actions">
              <button
                type="button"
                className="icon-btn icon-btn--primary"
                onClick={() => onPermission(item.id, "allowOnce")}
              >
                Allow once
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => onPermission(item.id, "allowForConversation")}
              >
                Allow for this conversation
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--danger"
                onClick={() => onPermission(item.id, "deny")}
              >
                Deny
              </button>
            </div>
          ) : (
            <span className="agent-card__decision" data-decision={item.decision}>
              {DECISION_TEXT[item.decision]}
            </span>
          )}
        </div>
      );

    case "turnEnd": {
      const note = STOP_TEXT[item.stopReason];
      return (
        <div className="agent-turn-end" data-testid="agent-turn-end">
          {note ? <span className="agent-turn-end__note">{note}</span> : null}
          {item.revert === "none" ? null : item.revert === "reverted" ? (
            <span className="agent-turn-end__note">Turn reverted</span>
          ) : item.revert === "failed" ? (
            <span className="agent-turn-end__note agent-turn-end__note--error">
              Couldn&apos;t revert this turn
            </span>
          ) : item.revert === "conflict" ? (
            <>
              <span className="agent-turn-end__note agent-turn-end__note--error">
                Some of these elements were edited since. Reverting will discard those edits.
              </span>
              <button
                type="button"
                className="icon-btn icon-btn--danger agent-turn-end__revert"
                onClick={() => onRevert(item.turnId, true)}
              >
                <UndoIcon />
                <span>Revert anyway</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="icon-btn agent-turn-end__revert"
              onClick={() => onRevert(item.turnId)}
              disabled={item.revert === "reverting"}
              title="Undo every canvas change the agent made in this turn"
            >
              <UndoIcon />
              <span>{item.revert === "reverting" ? "Reverting…" : "Revert turn"}</span>
            </button>
          )}
        </div>
      );
    }

    case "error":
      return (
        <div className="agent-card agent-card--error" role="alert" data-testid="agent-error">
          <span>{errorGuidance(item.errorKind, engine, item.message)}</span>
          {item.errorKind !== "other" && item.message ? (
            <span className="agent-card__meta">{item.message}</span>
          ) : null}
          {item.fatal ? (
            <div className="agent-card__actions">
              {item.errorKind === "notInstalled" && engine ? (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => openExternal(ENGINE_META[engine].installUrl)}
                >
                  Install guide
                </button>
              ) : null}
              <button type="button" className="icon-btn" onClick={onRetry}>
                <RefreshIcon />
                <span>Retry</span>
              </button>
            </div>
          ) : null}
        </div>
      );
  }
}
