/**
 * Docked AI agent panel — one conversation per tab (D-AI2).
 * Spec: docs/ai-integration.md § UX. All IPC goes through `useAgentStore`,
 * which refuses to call anything while the `ai` setting is off.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { EngineKind } from "../../agent/types";
import { emptyConversation, useAgentStore } from "../../stores/agentStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { log } from "../../lib/logger";
import { ENGINE_META, disclosureText, formatUsage } from "./engineMeta";
import { TranscriptItemView } from "./TranscriptItem";
import {
  CloseIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  SettingsIcon,
  SparklesIcon,
  StopIcon,
} from "../icons";

export interface AgentPanelProps {
  /** Active tab the conversation belongs to; null when no tab is open. */
  tabId: string | null;
  /** Other people in the live-collab session on this tab (0 when not shared). */
  collabParticipants?: number;
  /** Viewer-only guest in a shared session — the agent can't edit. */
  readOnly?: boolean;
  onOpenSettings?: () => void;
}

const QUICK_ACTIONS = [
  "Explain this diagram",
  "Tidy up the layout",
  "Draw a flowchart of a user sign-up process",
];

const RESIZE_STEP = 24;

export function AgentPanel({
  tabId,
  collabParticipants = 0,
  readOnly = false,
  onOpenSettings,
}: AgentPanelProps) {
  const ai = useSettingsStore((s) => s.ai);
  // Re-render when engine settings change (they feed availableEngines()).
  useSettingsStore((s) => s.aiEngines);
  const panelOpen = useAgentStore((s) => s.panelOpen);
  const panelWidth = useAgentStore((s) => s.panelWidth);
  const engines = useAgentStore((s) => s.engines);
  const detecting = useAgentStore((s) => s.detecting);
  const pendingDisclosure = useAgentStore((s) => s.pendingDisclosure);
  const conversation = useAgentStore((s) => (tabId ? s.conversations[tabId] : undefined));
  const store = useAgentStore.getState;

  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const visible = ai && panelOpen;

  useEffect(() => {
    if (visible && engines.length === 0) void store().detect();
  }, [visible, engines.length, store]);

  const itemCount = conversation?.items.length ?? 0;
  const lastItem = conversation?.items[itemCount - 1];
  const lastText = lastItem?.kind === "assistant" ? lastItem.text.length : 0;
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [itemCount, lastText]);

  if (!visible) return null;

  const conv = conversation ?? emptyConversation(tabId ?? "");
  const available = store().availableEngines();
  const engine: EngineKind | null = tabId ? store().engineFor(tabId) : null;
  const running = conv.status === "running";
  const starting = conv.status === "starting";
  const noEngine = !detecting && engines.length > 0 && available.length === 0;
  const disclosure =
    pendingDisclosure && pendingDisclosure.tabId === tabId ? pendingDisclosure : null;
  const composerDisabled = !tabId || readOnly || noEngine || !!disclosure;
  const usage = formatUsage(conv.usage);

  const submit = (text = draft) => {
    if (!tabId || composerDisabled || running || !text.trim()) return;
    void store().send(tabId, text);
    if (text === draft) setDraft("");
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const attachFolder = async () => {
    if (!tabId) return;
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") await store().setAttachedFolder(tabId, picked);
    } catch (e) {
      log.warn("agent: attach folder failed", e);
    }
  };

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const move = (ev: PointerEvent) => store().setPanelWidth(startW + (startX - ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") store().setPanelWidth(panelWidth + RESIZE_STEP);
    else if (e.key === "ArrowRight") store().setPanelWidth(panelWidth - RESIZE_STEP);
    else return;
    e.preventDefault();
  };

  const style = { "--agent-panel-width": `${panelWidth}px` } as CSSProperties;

  return (
    <aside className="agent-panel" style={style} aria-label="AI agent" data-testid="agent-panel">
      <div
        className="agent-panel__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize AI panel"
        aria-valuenow={panelWidth}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
      />

      <header className="agent-panel__header">
        <SparklesIcon className="agent-panel__logo" />
        {available.length > 0 && tabId ? (
          <select
            className="agent-panel__engine"
            aria-label="Agent engine"
            value={engine ?? ""}
            onChange={(e) => void store().selectEngine(tabId, e.target.value as EngineKind)}
            disabled={running}
            data-testid="agent-engine-select"
          >
            {available.map((e) => (
              <option key={e} value={e}>
                {ENGINE_META[e].label}
              </option>
            ))}
          </select>
        ) : (
          <span className="agent-panel__title">AI agent</span>
        )}
        <span className="agent-panel__spacer" />
        <button
          type="button"
          className="icon-btn icon-btn--icon-only"
          onClick={() => tabId && void store().newConversation(tabId)}
          disabled={!tabId || running || itemCount === 0}
          aria-label="New conversation"
          title="New conversation"
          data-testid="agent-new"
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--icon-only"
          onClick={() => store().setPanelOpen(false)}
          aria-label="Close AI panel"
          title="Close AI panel"
          data-testid="agent-close"
        >
          <CloseIcon />
        </button>
      </header>

      {collabParticipants > 0 ? (
        <div className="agent-panel__banner" data-testid="agent-collab">
          Edits are shared with {collabParticipants} participant
          {collabParticipants === 1 ? "" : "s"}
        </div>
      ) : null}

      <div
        className="agent-panel__transcript"
        ref={transcriptRef}
        aria-live="polite"
        aria-busy={running}
        data-testid="agent-transcript"
      >
        {readOnly ? (
          <p className="agent-panel__empty" data-testid="agent-readonly">
            You&apos;re viewing a shared drawing. The AI agent is turned off for viewers — ask the
            host for edit access.
          </p>
        ) : noEngine ? (
          <div className="agent-panel__empty" data-testid="agent-no-engine">
            <p>
              No AI agent is ready. Install and sign in to GitHub Copilot CLI, Claude Code, or
              OpenAI Codex, then re-detect.
            </p>
            {onOpenSettings ? (
              <button type="button" className="icon-btn" onClick={onOpenSettings}>
                <SettingsIcon />
                <span>Open Settings → AI</span>
              </button>
            ) : null}
          </div>
        ) : itemCount === 0 && !disclosure ? (
          <div className="agent-panel__empty">
            <p>
              Ask {engine ? ENGINE_META[engine].label : "your agent"} to draw, edit, or explain this
              canvas.
            </p>
            <div className="agent-panel__quick">
              {QUICK_ACTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="icon-btn"
                  onClick={() => submit(q)}
                  disabled={composerDisabled}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {conv.items.map((item) => (
          <TranscriptItemView
            key={item.id}
            item={item}
            engine={conv.engine ?? engine}
            streaming={running && item.kind === "assistant" && item.turnId === conv.currentTurnId}
            onPermission={(requestId, decision) =>
              tabId && void store().respondPermission(tabId, requestId, decision)
            }
            onRevert={(turnId, force) => tabId && void store().revertTurn(tabId, turnId, force)}
            onRetry={() => tabId && void store().retry(tabId)}
          />
        ))}

        {conv.plan && conv.plan.length > 0 ? (
          <ol className="agent-plan" aria-label="Plan" data-testid="agent-plan">
            {conv.plan.map((p, i) => (
              <li key={i} data-status={p.status}>
                {p.content}
              </li>
            ))}
          </ol>
        ) : null}

        {starting ? (
          <p className="agent-panel__status">
            Starting {engine ? ENGINE_META[engine].label : "agent"}…
          </p>
        ) : null}

        {disclosure ? (
          <div
            className="agent-card agent-card--disclosure"
            role="group"
            aria-label="Privacy notice"
            data-testid="agent-disclosure"
          >
            <strong>Before you use {ENGINE_META[disclosure.engine].label}</strong>
            <p>{disclosureText(disclosure.engine)}</p>
            <div className="agent-card__actions">
              <button
                type="button"
                className="icon-btn icon-btn--primary"
                onClick={() => void store().acceptDisclosure()}
                data-testid="agent-disclosure-accept"
              >
                Continue
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => store().declineDisclosure()}
                data-testid="agent-disclosure-decline"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <form
        className="agent-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {conv.attachedFolder ? (
          <div className="agent-composer__chips">
            <span className="agent-chip" title={conv.attachedFolder} data-testid="agent-folder">
              <span className="agent-chip__text">
                Read-only: {conv.attachedFolder.split(/[\\/]/).filter(Boolean).pop()}
              </span>
              <button
                type="button"
                className="agent-chip__remove"
                onClick={() => tabId && void store().setAttachedFolder(tabId, null)}
                aria-label="Detach folder"
                title="Detach folder"
                disabled={running}
              >
                <CloseIcon />
              </button>
            </span>
          </div>
        ) : null}
        <textarea
          className="agent-composer__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKey}
          placeholder={readOnly ? "The agent is off for viewers" : "Ask the agent…"}
          aria-label="Message the agent"
          rows={3}
          disabled={composerDisabled}
          data-testid="agent-input"
        />
        <div className="agent-composer__row">
          <button
            type="button"
            className="icon-btn icon-btn--icon-only"
            onClick={() => void attachFolder()}
            disabled={composerDisabled || running}
            aria-label="Attach folder (read-only)"
            title="Attach folder… (read-only)"
            data-testid="agent-attach"
          >
            <PaperclipIcon />
          </button>
          <span className="agent-panel__spacer" />
          {running ? (
            <button
              type="button"
              className="icon-btn icon-btn--danger"
              onClick={() => tabId && void store().stop(tabId)}
              data-testid="agent-stop"
            >
              <StopIcon />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              className="icon-btn icon-btn--primary"
              disabled={composerDisabled || !draft.trim()}
              data-testid="agent-send"
            >
              <SendIcon />
              <span>Send</span>
            </button>
          )}
        </div>
      </form>

      <footer className="agent-panel__footer" data-testid="agent-footer">
        <span>{engine ? `Uses your ${ENGINE_META[engine].plan} plan` : "No engine selected"}</span>
        {usage ? <span>{usage}</span> : null}
      </footer>
    </aside>
  );
}
