import { useEffect, useRef, useState } from "react";
import { isLocked, useAgentStore, type Conversation } from "../../stores/agentStore";
import { ENGINE_META } from "./engineMeta";
import { ChevronDownIcon, CloseIcon, PlusIcon } from "../icons";

interface Props {
  tabId: string | null;
  conversation: Conversation;
  running: boolean;
}

function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Header title + menu listing this drawing's conversations (D-AI2: several per tab). */
export function ConversationSwitcher({ tabId, conversation, running }: Props) {
  const history = useAgentStore((s) => (tabId ? s.history[tabId] : undefined)) ?? [];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const store = useAgentStore.getState;
  const started = isLocked(conversation);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const title = conversation.title || "New conversation";
  const entries = [
    ...(started
      ? [
          {
            id: conversation.id,
            title,
            engine: conversation.engine,
            updatedAt: conversation.updatedAt,
          },
        ]
      : []),
    ...history,
  ];

  return (
    <div className="agent-switcher" ref={rootRef}>
      <button
        type="button"
        className="agent-switcher__toggle"
        onClick={() => setOpen((o) => !o)}
        disabled={!tabId}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Conversations"
        data-testid="agent-conversations"
      >
        <span className="agent-switcher__title">{title}</span>
        <ChevronDownIcon />
      </button>
      {open && tabId ? (
        <div className="agent-switcher__menu" role="menu" data-testid="agent-conversation-menu">
          <button
            type="button"
            role="menuitem"
            className="agent-switcher__new"
            disabled={!started || running}
            onClick={() => {
              setOpen(false);
              void store().newConversation(tabId);
            }}
            data-testid="agent-new"
          >
            <PlusIcon />
            <span>New conversation</span>
          </button>
          {entries.length === 0 ? (
            <p className="agent-switcher__empty">No earlier conversations for this drawing.</p>
          ) : (
            <ul className="agent-switcher__list">
              {entries.map((e) => {
                const active = e.id === conversation.id;
                return (
                  <li key={e.id} className="agent-switcher__item" data-active={active}>
                    <button
                      type="button"
                      role="menuitem"
                      className="agent-switcher__open"
                      disabled={active || running}
                      aria-current={active}
                      onClick={() => {
                        setOpen(false);
                        void store().openConversation(tabId, e.id);
                      }}
                      data-testid="agent-conversation-item"
                    >
                      <span className="agent-switcher__item-title">{e.title || "Untitled"}</span>
                      <span className="agent-switcher__meta">
                        {e.engine ? ENGINE_META[e.engine].label : ""} · {relativeTime(e.updatedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="agent-chip__remove"
                      disabled={running && active}
                      onClick={() => void store().deleteConversation(tabId, e.id)}
                      aria-label={`Delete conversation ${e.title}`}
                      title="Delete conversation"
                      data-testid="agent-conversation-delete"
                    >
                      <CloseIcon />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
