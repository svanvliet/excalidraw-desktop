/**
 * Per-tab AI agent conversations (docs/ai-integration.md, FR-29…FR-33).
 *
 * State is reduced from `agent://event` envelopes. Every action that would
 * reach an engine is gated on the `ai` setting: with AI off this store never
 * calls an `agent_*` IPC command (privacy contract, FR-33).
 */
import { create } from "zustand";
import type {
  AgentEvent,
  AgentEventEnvelope,
  EngineInfo,
  EngineKind,
  ErrorKind,
  ModelOption,
  PermissionDecision,
  PlanEntry,
  StopReason,
  ToolCallStatus,
  ToolSource,
  Usage,
} from "../agent/types";
import {
  agentCancel,
  agentDetect,
  agentPermissionRespond,
  agentPrompt,
  agentSetModel,
  agentStart,
  agentStop,
} from "../ipc/commands";
import {
  deleteConversationsKey,
  docKey,
  flushConversations,
  loadConversations,
  loadKnownModels,
  renameConversationsKey,
  saveConversations,
  saveKnownModels,
  titleFrom,
  type ConversationIndex,
  type ConversationRecord,
} from "../agent/conversationStore";
import { ENGINE_CAPS } from "../components/agent/engineCaps";
import { onAgentEvent } from "../ipc/agentEvents";
import { ENGINE_KINDS, useSettingsStore } from "./settingsStore";
import { useTabsStore } from "./tabsStore";
import { log } from "../lib/logger";

// ---------------------------------------------------------------------------
// Turn hooks — implemented by the scene-tools lane (undo step + Revert turn).
// ---------------------------------------------------------------------------

/** `"conflict"`: someone edited the agent's elements since; retry with `force` after confirming. */
export type RevertOutcome = boolean | "conflict";

export interface TurnController {
  beginTurn(tabId: string, turnId: string): void;
  /** Returns how many elements the turn touched (0 hides "Revert turn"), if known. */
  endTurn(tabId: string, turnId: string): number | void;
  /** Resolve false (or throw) if the turn couldn't be reverted. */
  revertTurn(
    tabId: string,
    turnId: string,
    opts?: { force?: boolean },
  ): Promise<RevertOutcome> | RevertOutcome;
}

const NOOP_TURN_CONTROLLER: TurnController = {
  beginTurn: () => {},
  endTurn: () => {},
  revertTurn: () => false,
};
let turnController: TurnController = NOOP_TURN_CONTROLLER;

export function setTurnController(c: TurnController | null): void {
  turnController = c ?? NOOP_TURN_CONTROLLER;
}

// ---------------------------------------------------------------------------
// Conversation model
// ---------------------------------------------------------------------------

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; turnId: string; text: string; thinking: string }
  | {
      kind: "tool";
      id: string;
      turnId: string;
      name: string;
      title: string | null;
      source: ToolSource;
      status: ToolCallStatus;
      input: unknown;
      output: string | null;
    }
  | {
      kind: "permission";
      id: string;
      turnId: string;
      toolName: string;
      title: string;
      detail: string | null;
      /** null = awaiting a decision; "expired" = the turn ended first. */
      decision: PermissionDecision | "expired" | null;
    }
  | {
      kind: "turnEnd";
      id: string;
      turnId: string;
      stopReason: StopReason;
      usage: Usage | null;
      revert: "available" | "reverting" | "reverted" | "failed" | "conflict" | "none";
    }
  | { kind: "error"; id: string; errorKind: ErrorKind; message: string; fatal: boolean };

export type ConversationStatus = "idle" | "starting" | "ready" | "running" | "error" | "exited";

export interface Conversation {
  /** App-side id; keys the persisted record and the engine's scratch cwd. */
  id: string;
  tabId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  engine: EngineKind | null;
  /** Model picked in the panel; overrides the Settings default when the session starts. */
  requestedModel: string | null;
  sessionId: string | null;
  status: ConversationStatus;
  version: string | null;
  model: string | null;
  /** Models the engine offered for this session (empty until it reports them). */
  availableModels: ModelOption[];
  engineSessionId: string | null;
  currentTurnId: string | null;
  items: TranscriptItem[];
  plan: PlanEntry[] | null;
  /** Cumulative usage across the conversation's turns. */
  usage: Usage;
  attachedFolder: string | null;
  lastError: { kind: ErrorKind; message: string } | null;
}

const EMPTY_USAGE: Usage = { inputTokens: null, outputTokens: null, premiumRequests: null };

let conversationCounter = 0;
function newConversationId(): string {
  conversationCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `c-${Date.now().toString(36)}-${rand}${conversationCounter}`;
}

export function emptyConversation(tabId: string, engine: EngineKind | null = null): Conversation {
  const now = Date.now();
  return {
    id: newConversationId(),
    tabId,
    title: "",
    createdAt: now,
    updatedAt: now,
    engine,
    requestedModel: null,
    sessionId: null,
    status: "idle",
    version: null,
    model: null,
    availableModels: [],
    engineSessionId: null,
    currentTurnId: null,
    items: [],
    plan: null,
    usage: { ...EMPTY_USAGE },
    attachedFolder: null,
    lastError: null,
  };
}

/**
 * Engine, model (for engines without a live switch) and folder are fixed once the
 * conversation has started: the engine session already exists with them.
 */
export function isLocked(c: Conversation): boolean {
  return c.engineSessionId !== null || c.items.some((it) => it.kind === "user");
}

/** Persistable snapshot, or null for a conversation that never got a prompt. */
export function toRecord(c: Conversation): ConversationRecord | null {
  if (!c.engine || !c.items.some((it) => it.kind === "user")) return null;
  return {
    id: c.id,
    engine: c.engine,
    engineSessionId: c.engineSessionId,
    title: c.title,
    model: c.model ?? c.requestedModel,
    attachedFolder: c.attachedFolder,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    items: c.items,
    usage: c.usage,
  };
}

/** Rehydrate a stored conversation; it resumes the engine session on the next prompt. */
export function fromRecord(tabId: string, r: ConversationRecord): Conversation {
  return {
    ...emptyConversation(tabId, r.engine),
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    requestedModel: r.model,
    model: r.model,
    engineSessionId: r.engineSessionId,
    attachedFolder: r.attachedFolder,
    items: r.items,
    usage: r.usage,
  };
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

function addUsage(total: Usage, u: Usage | null): Usage {
  if (!u) return total;
  return {
    inputTokens: addNullable(total.inputTokens, u.inputTokens),
    outputTokens: addNullable(total.outputTokens, u.outputTokens),
    premiumRequests: addNullable(total.premiumRequests, u.premiumRequests),
  };
}

let itemCounter = 0;
function nextItemId(prefix: string): string {
  itemCounter += 1;
  return `${prefix}-${itemCounter}`;
}

function expirePermissions(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((it) =>
    it.kind === "permission" && it.decision === null ? { ...it, decision: "expired" } : it,
  );
}

function appendAssistant(
  items: TranscriptItem[],
  turnId: string,
  field: "text" | "thinking",
  delta: string,
): TranscriptItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.turnId === turnId) {
    return [...items.slice(0, -1), { ...last, [field]: last[field] + delta }];
  }
  return [
    ...items,
    {
      kind: "assistant",
      id: nextItemId("a"),
      turnId,
      text: field === "text" ? delta : "",
      thinking: field === "thinking" ? delta : "",
    },
  ];
}

/** Pure reducer: fold one agent event into a conversation. */
export function reduceAgentEvent(conv: Conversation, event: AgentEvent): Conversation {
  switch (event.type) {
    case "models":
      return { ...conv, availableModels: event.available };
    case "modelChanged":
      return { ...conv, model: event.model };
    case "ready":
      return {
        ...conv,
        engine: event.engine,
        status: conv.currentTurnId ? conv.status : "ready",
        version: event.version,
        model: event.model,
        engineSessionId: event.engineSessionId ?? conv.engineSessionId,
        lastError: null,
      };
    case "turnStarted":
      return { ...conv, status: "running", currentTurnId: event.turnId, plan: null };
    case "textDelta":
      return { ...conv, items: appendAssistant(conv.items, event.turnId, "text", event.text) };
    case "thinkingDelta":
      return { ...conv, items: appendAssistant(conv.items, event.turnId, "thinking", event.text) };
    case "toolCall": {
      const idx = conv.items.findIndex((it) => it.kind === "tool" && it.id === event.callId);
      const item: TranscriptItem = {
        kind: "tool",
        id: event.callId,
        turnId: event.turnId,
        name: event.name,
        title: event.title,
        source: event.source,
        status: event.status,
        input: event.input,
        output: event.output,
      };
      if (idx === -1) return { ...conv, items: [...conv.items, item] };
      const items = conv.items.slice();
      items[idx] = item;
      return { ...conv, items };
    }
    case "permissionRequest":
      return {
        ...conv,
        items: [
          ...conv.items,
          {
            kind: "permission",
            id: event.requestId,
            turnId: event.turnId,
            toolName: event.toolName,
            title: event.title,
            detail: event.detail,
            decision: null,
          },
        ],
      };
    case "plan":
      return { ...conv, plan: event.entries };
    case "turnEnded":
      return {
        ...conv,
        status: conv.status === "running" ? "ready" : conv.status,
        currentTurnId: conv.currentTurnId === event.turnId ? null : conv.currentTurnId,
        usage: addUsage(conv.usage, event.usage),
        items: [
          ...expirePermissions(conv.items),
          {
            kind: "turnEnd",
            id: nextItemId("t"),
            turnId: event.turnId,
            stopReason: event.stopReason,
            usage: event.usage,
            revert: "available",
          },
        ],
      };
    case "error":
      return {
        ...conv,
        status: event.fatal ? "error" : conv.status,
        currentTurnId: event.fatal ? null : conv.currentTurnId,
        lastError: { kind: event.kind, message: event.message },
        items: [
          ...(event.fatal ? expirePermissions(conv.items) : conv.items),
          {
            kind: "error",
            id: nextItemId("e"),
            errorKind: event.kind,
            message: event.message,
            fatal: event.fatal,
          },
        ],
      };
    case "exited":
      return {
        ...conv,
        status: conv.status === "error" ? "error" : "exited",
        sessionId: null,
        currentTurnId: null,
        items: expirePermissions(conv.items),
      };
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface PendingDisclosure {
  tabId: string;
  engine: EngineKind;
  /** Prompt to send once the user accepts. */
  text: string;
}

export interface AgentState {
  /** The active conversation of each tab. */
  conversations: Record<string, Conversation>;
  /** Other (stored) conversations of each tab, most recent first. */
  history: Record<string, ConversationRecord[]>;
  /** Tabs whose stored conversations were loaded (saving waits for this). */
  hydrated: Record<string, boolean>;
  /** Last model list each engine reported (drives the picker before a session exists). */
  knownModels: Partial<Record<EngineKind, ModelOption[]>>;
  panelOpen: boolean;
  panelWidth: number;
  engines: EngineInfo[];
  detecting: boolean;
  pendingDisclosure: PendingDisclosure | null;

  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setPanelWidth: (px: number) => void;
  /** Probe installed engines (Settings → AI "Re-detect"). */
  detect: () => Promise<EngineInfo[]>;
  /** Engines that are enabled in settings and detected as ready. */
  availableEngines: () => EngineKind[];
  /** Engine a tab's conversation uses (explicit pick → default → first available). */
  engineFor: (tabId: string) => EngineKind | null;
  /** Pick the engine of a conversation that hasn't started yet. */
  selectEngine: (tabId: string, engine: EngineKind) => Promise<void>;
  /** Pick the model: before the first prompt, or live where the engine supports it. */
  setModel: (tabId: string, model: string | null) => Promise<void>;
  /** Load a tab's stored conversations (no-op with AI off or when already loaded). */
  hydrate: (tabId: string) => Promise<void>;
  /** Switch to a stored conversation; its engine session resumes on the next prompt. */
  openConversation: (tabId: string, id: string) => Promise<void>;
  deleteConversation: (tabId: string, id: string) => Promise<void>;
  /** Start (or reuse) the engine session for a tab. Null if gated/declined. */
  ensureSession: (tabId: string) => Promise<string | null>;
  send: (tabId: string, text: string) => Promise<void>;
  acceptDisclosure: () => Promise<void>;
  declineDisclosure: () => void;
  stop: (tabId: string) => Promise<void>;
  respondPermission: (
    tabId: string,
    requestId: string,
    decision: PermissionDecision,
  ) => Promise<void>;
  revertTurn: (tabId: string, turnId: string, force?: boolean) => Promise<void>;
  /** Attach/detach the read-only folder; only before the conversation starts. */
  setAttachedFolder: (tabId: string, path: string | null) => Promise<void>;
  /** Keep the current conversation in history and start an empty one. */
  newConversation: (tabId: string) => Promise<void>;
  /** Restart a crashed/exited session, resuming the engine thread if possible. */
  retry: (tabId: string) => Promise<void>;
  /** Tab closed → stop its session; untitled tabs also drop their stored conversations. */
  closeTab: (tabId: string) => Promise<void>;
  /** AI turned off → stop everything. */
  stopAll: () => Promise<void>;
  handleEnvelope: (env: AgentEventEnvelope) => void;
}

export const DEFAULT_PANEL_WIDTH = 360;
export const MIN_PANEL_WIDTH = 280;
export const MAX_PANEL_WIDTH = 720;

function aiOn(): boolean {
  return useSettingsStore.getState().ai;
}

/** Sessions we stopped; late events from them are ignored. */
const retiredSessions = new Set<string>();
let unlistenEvents: (() => void) | null = null;
let subscribing: Promise<void> | null = null;

async function ensureSubscribed(): Promise<void> {
  if (unlistenEvents) return;
  if (!subscribing) {
    subscribing = onAgentEvent((env) => useAgentStore.getState().handleEnvelope(env))
      .then((un) => {
        unlistenEvents = un;
      })
      .catch((e) => {
        log.warn("agentStore: failed to subscribe to agent events", e);
      })
      .finally(() => {
        subscribing = null;
      });
  }
  await subscribing;
}

function describeError(e: unknown): { kind: ErrorKind; message: string } {
  if (e && typeof e === "object") {
    const r = e as Record<string, unknown>;
    const message = typeof r.message === "string" ? r.message : String(e);
    const kinds: ErrorKind[] = [
      "notInstalled",
      "notLoggedIn",
      "orgDisabled",
      "unsupportedVersion",
      "quotaExceeded",
      "crashed",
      "protocol",
      "timeout",
    ];
    const kind = kinds.find((k) => k === r.kind) ?? "other";
    return { kind, message };
  }
  return { kind: "other", message: String(e) };
}

export const useAgentStore = create<AgentState>((set, get) => {
  const conv = (tabId: string): Conversation =>
    get().conversations[tabId] ?? emptyConversation(tabId);
  const patch = (tabId: string, fn: (c: Conversation) => Conversation) =>
    set((s) => ({
      conversations: {
        ...s.conversations,
        [tabId]: fn(s.conversations[tabId] ?? emptyConversation(tabId)),
      },
    }));
  const pushError = (tabId: string, e: unknown, fatal = true) => {
    const { kind, message } = describeError(e);
    patch(tabId, (c) => reduceAgentEvent(c, { type: "error", kind, message, fatal }));
  };
  /** Move the active conversation into history (if it has content) and stop its session. */
  const archiveActive = async (tabId: string) => {
    const c = get().conversations[tabId];
    if (!c) return;
    await retire(c.sessionId);
    const rec = toRecord(c);
    if (!rec) return;
    set((s) => ({
      history: {
        ...s.history,
        [tabId]: [rec, ...(s.history[tabId] ?? []).filter((r) => r.id !== rec.id)],
      },
    }));
  };
  const retire = async (sessionId: string | null) => {
    if (!sessionId) return;
    retiredSessions.add(sessionId);
    try {
      await agentStop(sessionId);
    } catch (e) {
      log.warn("agentStore: agentStop failed", e);
    }
  };

  return {
    conversations: {},
    history: {},
    hydrated: {},
    knownModels: {},
    panelOpen: false,
    panelWidth: DEFAULT_PANEL_WIDTH,
    engines: [],
    detecting: false,
    pendingDisclosure: null,

    setPanelOpen(open) {
      set({ panelOpen: open && aiOn() });
    },
    togglePanel() {
      get().setPanelOpen(!get().panelOpen);
    },
    setPanelWidth(px) {
      set({ panelWidth: Math.round(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, px))) });
    },

    async detect() {
      if (!aiOn()) return get().engines;
      set({ detecting: true });
      try {
        const { aiEngines } = useSettingsStore.getState();
        const overrides = ENGINE_KINDS.filter((e) => aiEngines[e].pathOverride.trim()).map((e) => ({
          engine: e,
          path: aiEngines[e].pathOverride.trim(),
        }));
        const engines = await agentDetect(overrides);
        set({ engines });
        return engines;
      } catch (e) {
        log.warn("agentStore: detect failed", e);
        return get().engines;
      } finally {
        set({ detecting: false });
      }
    },

    availableEngines() {
      const { aiEngines } = useSettingsStore.getState();
      const ready = new Set(
        get()
          // `unknown` = installed but sign-in can only be checked by starting a
          // session (Copilot); a not-signed-in error surfaces in the panel then.
          .engines.filter((i) => i.status === "ready" || i.status === "unknown")
          .map((i) => i.engine),
      );
      return ENGINE_KINDS.filter((e) => aiEngines[e].enabled && ready.has(e));
    },

    engineFor(tabId) {
      const picked = get().conversations[tabId]?.engine;
      if (picked) return picked;
      const available = get().availableEngines();
      const { aiDefaultEngine, aiEngines } = useSettingsStore.getState();
      if (available.includes(aiDefaultEngine)) return aiDefaultEngine;
      if (available.length > 0) return available[0];
      // Detection may not have run yet; fall back to the default if enabled.
      return aiEngines[aiDefaultEngine].enabled ? aiDefaultEngine : null;
    },

    async selectEngine(tabId, engine) {
      const c = conv(tabId);
      if (c.engine === engine || isLocked(c)) return;
      await retire(c.sessionId);
      patch(tabId, (x) => ({
        ...emptyConversation(tabId, engine),
        id: x.id,
        attachedFolder: x.attachedFolder,
        items: x.items,
      }));
      void loadKnownModelsFor(engine);
    },

    async setModel(tabId, model) {
      const c = conv(tabId);
      const next = model?.trim() || null;
      if (!isLocked(c)) {
        patch(tabId, (x) => ({ ...x, requestedModel: next }));
        return;
      }
      const engine = c.engine;
      if (!next || !engine || !ENGINE_CAPS[engine].liveModelSwitch || next === c.model) return;
      // Remembered for a resume; applied live when a session is running.
      patch(tabId, (x) => ({ ...x, requestedModel: next }));
      if (!aiOn() || !c.sessionId) {
        patch(tabId, (x) => ({ ...x, model: next }));
        return;
      }
      try {
        await agentSetModel(c.sessionId, next);
      } catch (e) {
        log.warn("agentStore: agentSetModel failed", e);
        pushError(tabId, e, false);
      }
    },

    async hydrate(tabId) {
      if (!aiOn() || get().hydrated[tabId]) return;
      const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const index = await loadConversations(docKey(tab));
      set((s) => {
        const list = index?.list ?? [];
        const current = s.conversations[tabId];
        const active =
          !current || !isLocked(current) ? list.find((r) => r.id === index?.activeId) : undefined;
        const known = new Set(current && isLocked(current) ? [current.id] : []);
        if (active) known.add(active.id);
        return {
          hydrated: { ...s.hydrated, [tabId]: true },
          history: {
            ...s.history,
            [tabId]: [...list.filter((r) => !known.has(r.id)), ...(s.history[tabId] ?? [])].sort(
              (a, b) => b.updatedAt - a.updatedAt,
            ),
          },
          conversations: active
            ? { ...s.conversations, [tabId]: fromRecord(tabId, active) }
            : s.conversations,
        };
      });
      const engine = get().engineFor(tabId);
      if (engine) void loadKnownModelsFor(engine);
    },

    async openConversation(tabId, id) {
      const rec = (get().history[tabId] ?? []).find((r) => r.id === id);
      if (!rec || get().conversations[tabId]?.id === id) return;
      await archiveActive(tabId);
      set((s) => ({
        history: { ...s.history, [tabId]: (s.history[tabId] ?? []).filter((r) => r.id !== id) },
        conversations: { ...s.conversations, [tabId]: fromRecord(tabId, rec) },
      }));
    },

    async deleteConversation(tabId, id) {
      if (get().conversations[tabId]?.id === id) {
        const c = conv(tabId);
        await retire(c.sessionId);
        patch(tabId, () => emptyConversation(tabId));
      }
      set((s) => ({
        history: { ...s.history, [tabId]: (s.history[tabId] ?? []).filter((r) => r.id !== id) },
      }));
    },

    async ensureSession(tabId) {
      if (!aiOn()) return null;
      const c = conv(tabId);
      if (c.sessionId) return c.sessionId;
      const engine = get().engineFor(tabId);
      if (!engine) {
        pushError(tabId, { kind: "notInstalled", message: "No enabled agent engine is ready." });
        return null;
      }
      const settings = useSettingsStore.getState();
      if (!settings.aiDisclosureAccepted[engine]) return null;
      const es = settings.aiEngines[engine];
      patch(tabId, (x) => ({ ...x, engine, status: "starting", lastError: null }));
      await ensureSubscribed();
      try {
        const sessionId = await agentStart({
          tabId,
          engine,
          pathOverride: es.pathOverride.trim() || null,
          useHostConfig: es.useHostConfig,
          model: c.requestedModel ?? (es.model.trim() || null),
          attachedFolder: c.attachedFolder,
          resumeId: c.engineSessionId,
          conversationId: c.id,
        });
        patch(tabId, (x) => ({
          ...x,
          sessionId,
          status: x.status === "starting" ? "ready" : x.status,
        }));
        return sessionId;
      } catch (e) {
        log.warn("agentStore: agentStart failed", e);
        patch(tabId, (x) => ({ ...x, status: "error" }));
        pushError(tabId, e);
        return null;
      }
    },

    async send(tabId, text) {
      const trimmed = text.trim();
      if (!trimmed || !aiOn()) return;
      const engine = get().engineFor(tabId);
      if (engine && !useSettingsStore.getState().aiDisclosureAccepted[engine]) {
        set({ pendingDisclosure: { tabId, engine, text: trimmed } });
        return;
      }
      patch(tabId, (c) => ({
        ...c,
        engine: c.engine ?? engine,
        title: c.title || titleFrom(trimmed),
        updatedAt: Date.now(),
        items: [...c.items, { kind: "user", id: nextItemId("u"), text: trimmed }],
      }));
      const sessionId = await get().ensureSession(tabId);
      if (!sessionId) return;
      patch(tabId, (c) => ({ ...c, status: "running" }));
      try {
        await agentPrompt(sessionId, trimmed);
      } catch (e) {
        log.warn("agentStore: agentPrompt failed", e);
        patch(tabId, (c) => ({ ...c, status: c.sessionId ? "ready" : c.status }));
        pushError(tabId, e, false);
      }
    },

    async acceptDisclosure() {
      const pending = get().pendingDisclosure;
      if (!pending) return;
      set({ pendingDisclosure: null });
      await useSettingsStore.getState().acceptAiDisclosure(pending.engine);
      await get().send(pending.tabId, pending.text);
    },

    declineDisclosure() {
      set({ pendingDisclosure: null });
    },

    async stop(tabId) {
      const c = conv(tabId);
      if (!aiOn() || !c.sessionId) return;
      try {
        await agentCancel(c.sessionId);
      } catch (e) {
        log.warn("agentStore: agentCancel failed", e);
      }
    },

    async respondPermission(tabId, requestId, decision) {
      const c = conv(tabId);
      if (!aiOn() || !c.sessionId) return;
      const mark = (d: PermissionDecision | null) =>
        patch(tabId, (x) => ({
          ...x,
          items: x.items.map((it) =>
            it.kind === "permission" && it.id === requestId ? { ...it, decision: d } : it,
          ),
        }));
      mark(decision);
      try {
        await agentPermissionRespond(c.sessionId, requestId, decision);
      } catch (e) {
        log.warn("agentStore: agentPermissionRespond failed", e);
        mark(null);
        pushError(tabId, e, false);
      }
    },

    async revertTurn(tabId, turnId, force = false) {
      const setRevert = (r: "available" | "reverting" | "reverted" | "failed" | "conflict") =>
        patch(tabId, (x) => ({
          ...x,
          items: x.items.map((it) =>
            it.kind === "turnEnd" && it.turnId === turnId ? { ...it, revert: r } : it,
          ),
        }));
      setRevert("reverting");
      try {
        const ok = await turnController.revertTurn(tabId, turnId, { force });
        setRevert(ok === "conflict" ? "conflict" : ok ? "reverted" : "failed");
      } catch (e) {
        log.warn("agentStore: revertTurn failed", e);
        setRevert("failed");
      }
    },

    async setAttachedFolder(tabId, path) {
      const c = conv(tabId);
      if (c.attachedFolder === path || isLocked(c)) return;
      // The folder is a session start option.
      await retire(c.sessionId);
      patch(tabId, (x) => ({
        ...x,
        attachedFolder: path,
        sessionId: null,
        status: "idle",
        currentTurnId: null,
      }));
    },

    async newConversation(tabId) {
      const c = conv(tabId);
      if (!isLocked(c)) return;
      await archiveActive(tabId);
      patch(tabId, (x) => ({ ...emptyConversation(tabId, x.engine) }));
    },

    async retry(tabId) {
      const c = conv(tabId);
      await retire(c.sessionId);
      patch(tabId, (x) => ({ ...x, sessionId: null, status: "idle", lastError: null }));
      await get().ensureSession(tabId);
    },

    async closeTab(tabId) {
      const c = get().conversations[tabId];
      set((s) => {
        const conversations = { ...s.conversations };
        const history = { ...s.history };
        const hydrated = { ...s.hydrated };
        delete conversations[tabId];
        delete history[tabId];
        delete hydrated[tabId];
        return { conversations, history, hydrated };
      });
      if (c) await retire(c.sessionId);
    },

    async stopAll() {
      const all = Object.values(get().conversations);
      set({ panelOpen: false, pendingDisclosure: null });
      for (const c of all) {
        if (c.sessionId) {
          await retire(c.sessionId);
          patch(c.tabId, (x) => ({ ...x, sessionId: null, status: "idle", currentTurnId: null }));
        }
      }
    },

    handleEnvelope(env) {
      if (retiredSessions.has(env.sessionId)) return;
      const prev = get().conversations[env.tabId];
      if (!prev) return;
      if (prev.sessionId ? prev.sessionId !== env.sessionId : prev.status !== "starting") return;
      if (env.event.type === "exited") retiredSessions.add(env.sessionId);
      const next = reduceAgentEvent(
        prev.sessionId ? prev : { ...prev, sessionId: env.sessionId },
        env.event,
      );
      set((s) => ({ conversations: { ...s.conversations, [env.tabId]: next } }));

      const e = env.event;
      if (e.type === "models" && next.engine) {
        const engine = next.engine;
        set((s) => ({ knownModels: { ...s.knownModels, [engine]: e.available } }));
        if (aiOn()) void saveKnownModels(engine, e.available);
      }
      try {
        if (e.type === "turnStarted") {
          turnController.beginTurn(env.tabId, e.turnId);
        } else if (e.type === "turnEnded") {
          if (turnController.endTurn(env.tabId, e.turnId) === 0) {
            set((s) => {
              const c = s.conversations[env.tabId];
              if (!c) return s;
              const items = c.items.map((it) =>
                it.kind === "turnEnd" && it.turnId === e.turnId
                  ? { ...it, revert: "none" as const }
                  : it,
              );
              return { conversations: { ...s.conversations, [env.tabId]: { ...c, items } } };
            });
          }
        } else if (prev.currentTurnId && next.currentTurnId === null) {
          // Fatal error / exit mid-turn: still close the undo step.
          turnController.endTurn(env.tabId, prev.currentTurnId);
        }
      } catch (err) {
        log.warn("agentStore: turn controller threw", err);
      }
    },
  };
});

/** Load an engine's cached model list into `knownModels` (AI on only). */
export async function loadKnownModelsFor(engine: EngineKind): Promise<void> {
  if (!aiOn() || useAgentStore.getState().knownModels[engine]) return;
  const models = await loadKnownModels(engine);
  if (models.length === 0) return;
  useAgentStore.setState((s) =>
    s.knownModels[engine] ? s : { knownModels: { ...s.knownModels, [engine]: models } },
  );
}

/** Persisted shape of a tab: the active conversation first, then history. */
export function snapshotTab(state: AgentState, tabId: string): ConversationIndex {
  const active = state.conversations[tabId];
  const rec = active ? toRecord(active) : null;
  const history = (state.history[tabId] ?? []).filter((r) => r.id !== rec?.id);
  return { activeId: rec?.id ?? null, list: rec ? [rec, ...history] : history };
}

/**
 * Wire the store to app lifecycle: stop sessions when AI is switched off and
 * when a tab closes. Call once from App; returns a disposer.
 */
export function installAgentStore(): () => void {
  const unsubSettings = useSettingsStore.subscribe((s, prev) => {
    if (prev.ai && !s.ai) void useAgentStore.getState().stopAll();
  });
  const unsubTabs = useTabsStore.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    const open = new Map(s.tabs.map((t) => [t.id, t]));
    for (const t of prev.tabs) {
      const now = open.get(t.id);
      if (!now) {
        void useAgentStore.getState().closeTab(t.id);
        // Untitled drawings are gone for good; file-backed ones keep their history.
        if (t.path === null && aiOn()) void deleteConversationsKey(docKey(t));
      } else if (now.path !== t.path && aiOn()) {
        void renameConversationsKey(docKey(t), docKey(now));
      }
    }
  });
  // Persist conversations (debounced in conversationStore) once a tab's stored state is loaded.
  const unsubAgent = useAgentStore.subscribe((s, prev) => {
    if (!aiOn() || (s.conversations === prev.conversations && s.history === prev.history)) return;
    const tabs = useTabsStore.getState().tabs;
    for (const tab of tabs) {
      if (!s.hydrated[tab.id]) continue;
      if (
        s.conversations[tab.id] === prev.conversations[tab.id] &&
        s.history[tab.id] === prev.history[tab.id]
      )
        continue;
      saveConversations(docKey(tab), snapshotTab(s, tab.id));
    }
  });
  const flush = () => void flushConversations();
  window.addEventListener("beforeunload", flush);
  return () => {
    unsubSettings();
    unsubTabs();
    unsubAgent();
    window.removeEventListener("beforeunload", flush);
    unlistenEvents?.();
    unlistenEvents = null;
  };
}

/** Tests only. */
export function __resetAgentStoreForTests(): void {
  useAgentStore.setState({
    conversations: {},
    history: {},
    hydrated: {},
    knownModels: {},
    panelOpen: false,
    panelWidth: DEFAULT_PANEL_WIDTH,
    engines: [],
    detecting: false,
    pendingDisclosure: null,
  });
  retiredSessions.clear();
  unlistenEvents = null;
  subscribing = null;
  turnController = NOOP_TURN_CONTROLLER;
}
