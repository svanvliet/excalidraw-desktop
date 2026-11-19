import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentEvent, AgentEventEnvelope, EngineInfo } from "../agent/types";

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeStore {
    private data = new Map<string, unknown>();
    async get<T>(key: string): Promise<T | undefined> {
      return this.data.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      this.data.set(key, value);
    }
    async save(): Promise<void> {}
  }
  return { LazyStore: FakeStore };
});

const ipc = vi.hoisted(() => ({
  agentDetect: vi.fn(),
  agentStart: vi.fn(),
  agentPrompt: vi.fn(),
  agentCancel: vi.fn(),
  agentPermissionRespond: vi.fn(),
  agentStop: vi.fn(),
}));
vi.mock("../ipc/commands", () => ipc);

const events = vi.hoisted(() => ({
  handler: null as null | ((e: AgentEventEnvelope) => void),
  onAgentEvent: vi.fn(async (h: (e: AgentEventEnvelope) => void) => {
    events.handler = h;
    return () => {};
  }),
}));
vi.mock("../ipc/agentEvents", () => ({ onAgentEvent: events.onAgentEvent }));

import {
  __resetAgentStoreForTests,
  emptyConversation,
  installAgentStore,
  reduceAgentEvent,
  setTurnController,
  useAgentStore,
  type Conversation,
} from "./agentStore";
import { __resetSettingsForTests, useSettingsStore } from "./settingsStore";
import { useTabsStore } from "./tabsStore";

const READY: EngineInfo[] = [
  {
    engine: "copilot",
    status: "ready",
    path: "/bin/copilot",
    version: "1.0.0",
    minVersion: "0.0.300",
    message: null,
  },
  {
    engine: "claude",
    status: "notLoggedIn",
    path: "/bin/claude",
    version: "2.0.0",
    minVersion: "1.0.0",
    message: null,
  },
];

function emit(tabId: string, sessionId: string, event: AgentEvent) {
  events.handler?.({ tabId, sessionId, event });
}

function fold(events: AgentEvent[], start: Conversation = emptyConversation("t1")) {
  return events.reduce(reduceAgentEvent, start);
}

beforeEach(() => {
  __resetSettingsForTests();
  __resetAgentStoreForTests();
  events.handler = null;
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.agentDetect.mockResolvedValue(READY);
  ipc.agentStart.mockResolvedValue("s1");
  ipc.agentPrompt.mockResolvedValue("turn-1");
  ipc.agentCancel.mockResolvedValue(undefined);
  ipc.agentPermissionRespond.mockResolvedValue(undefined);
  ipc.agentStop.mockResolvedValue(undefined);
});

async function enableAi(acceptDisclosure = true) {
  await useSettingsStore.getState().setFlag("ai", true);
  if (acceptDisclosure) await useSettingsStore.getState().acceptAiDisclosure("copilot");
}

describe("reduceAgentEvent", () => {
  it("ready records engine metadata", () => {
    const c = fold([
      { type: "ready", engine: "codex", version: "0.5", model: "gpt-5", engineSessionId: "th-1" },
    ]);
    expect(c).toMatchObject({
      engine: "codex",
      status: "ready",
      version: "0.5",
      model: "gpt-5",
      engineSessionId: "th-1",
    });
  });

  it("streams text and thinking into one assistant message per run", () => {
    const c = fold([
      { type: "turnStarted", turnId: "T" },
      { type: "thinkingDelta", turnId: "T", text: "hmm " },
      { type: "thinkingDelta", turnId: "T", text: "ok" },
      { type: "textDelta", turnId: "T", text: "Hel" },
      { type: "textDelta", turnId: "T", text: "lo" },
    ]);
    expect(c.status).toBe("running");
    expect(c.currentTurnId).toBe("T");
    expect(c.items).toHaveLength(1);
    expect(c.items[0]).toMatchObject({ kind: "assistant", text: "Hello", thinking: "hmm ok" });
  });

  it("upserts tool calls by callId and splits assistant text around them", () => {
    const tool = {
      type: "toolCall" as const,
      turnId: "T",
      callId: "c1",
      name: "add_elements",
      title: null,
      source: "canvas" as const,
      input: {},
      output: null,
    };
    const c = fold([
      { type: "turnStarted", turnId: "T" },
      { type: "textDelta", turnId: "T", text: "a" },
      { ...tool, status: "running" },
      { ...tool, status: "completed", output: "Added 3" },
      { type: "textDelta", turnId: "T", text: "b" },
    ]);
    expect(c.items.map((i) => i.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect(c.items[1]).toMatchObject({ status: "completed", output: "Added 3", source: "canvas" });
  });

  it("plan replaces the plan; turnEnded adds a revertable marker, sums usage, expires prompts", () => {
    const c = fold([
      { type: "turnStarted", turnId: "T" },
      { type: "plan", turnId: "T", entries: [{ content: "draw", status: "pending" }] },
      {
        type: "permissionRequest",
        turnId: "T",
        requestId: "r1",
        toolName: "web_fetch",
        title: "Fetch a URL",
        detail: null,
      },
      {
        type: "turnEnded",
        turnId: "T",
        stopReason: "endTurn",
        usage: { inputTokens: 10, outputTokens: 5, premiumRequests: 1 },
      },
      {
        type: "turnEnded",
        turnId: "T2",
        stopReason: "cancelled",
        usage: { inputTokens: 1, outputTokens: null, premiumRequests: null },
      },
    ]);
    expect(c.plan).toEqual([{ content: "draw", status: "pending" }]);
    expect(c.status).toBe("ready");
    expect(c.currentTurnId).toBeNull();
    expect(c.usage).toEqual({ inputTokens: 11, outputTokens: 5, premiumRequests: 1 });
    expect(c.items[0]).toMatchObject({ kind: "permission", decision: "expired" });
    expect(c.items[1]).toMatchObject({ kind: "turnEnd", turnId: "T", revert: "available" });
  });

  it("non-fatal errors keep the turn; fatal errors and exit end it", () => {
    let c = fold([
      { type: "turnStarted", turnId: "T" },
      { type: "error", kind: "timeout", message: "slow", fatal: false },
    ]);
    expect(c.status).toBe("running");
    c = reduceAgentEvent(c, { type: "error", kind: "crashed", message: "boom", fatal: true });
    expect(c.status).toBe("error");
    expect(c.currentTurnId).toBeNull();
    expect(c.lastError).toEqual({ kind: "crashed", message: "boom" });
    c = reduceAgentEvent({ ...c, sessionId: "s" }, { type: "exited", code: 1 });
    expect(c.sessionId).toBeNull();
    expect(c.status).toBe("error");
    expect(reduceAgentEvent(emptyConversation("t"), { type: "exited", code: 0 }).status).toBe(
      "exited",
    );
  });
});

describe("agentStore privacy gate", () => {
  it("with AI off, no agent IPC is called by any action", async () => {
    const st = useAgentStore.getState();
    st.setPanelOpen(true);
    await st.detect();
    await st.send("t1", "hi");
    await st.ensureSession("t1");
    await st.stop("t1");
    await st.respondPermission("t1", "r", "allowOnce");
    expect(useAgentStore.getState().panelOpen).toBe(false);
    for (const f of Object.values(ipc)) expect(f).not.toHaveBeenCalled();
    expect(events.onAgentEvent).not.toHaveBeenCalled();
  });

  it("first use of an engine requires accepting the disclosure before anything starts", async () => {
    await enableAi(false);
    await useAgentStore.getState().detect();
    await useAgentStore.getState().send("t1", "draw a cat");
    expect(useAgentStore.getState().pendingDisclosure).toEqual({
      tabId: "t1",
      engine: "copilot",
      text: "draw a cat",
    });
    expect(ipc.agentStart).not.toHaveBeenCalled();

    useAgentStore.getState().declineDisclosure();
    expect(useAgentStore.getState().pendingDisclosure).toBeNull();
    await useAgentStore.getState().send("t1", "draw a cat");
    await useAgentStore.getState().acceptDisclosure();
    expect(useSettingsStore.getState().aiDisclosureAccepted.copilot).toBe(true);
    expect(ipc.agentStart).toHaveBeenCalledTimes(1);
    expect(ipc.agentPrompt).toHaveBeenCalledWith("s1", "draw a cat");
  });
});

describe("agentStore availableEngines", () => {
  it("offers engines whose sign-in is only verified at session start", async () => {
    await enableAi();
    useAgentStore.setState({
      engines: [
        { ...READY[0], status: "unknown" },
        { ...READY[1], status: "notLoggedIn" },
      ],
    });
    expect(useAgentStore.getState().availableEngines()).toEqual(["copilot"]);
  });
});

describe("agentStore session flow", () => {
  it("starts a session with per-engine settings, prompts, and reduces events", async () => {
    await enableAi();
    await useSettingsStore
      .getState()
      .setEngineSettings("copilot", { pathOverride: " /opt/c ", useHostConfig: false, model: "m" });
    await useAgentStore.getState().detect();
    expect(ipc.agentDetect).toHaveBeenCalledWith([{ engine: "copilot", path: "/opt/c" }]);
    expect(useAgentStore.getState().availableEngines()).toEqual(["copilot"]);

    await useAgentStore.getState().send("t1", "  hello ");
    expect(ipc.agentStart).toHaveBeenCalledWith({
      tabId: "t1",
      engine: "copilot",
      pathOverride: "/opt/c",
      useHostConfig: false,
      model: "m",
      attachedFolder: null,
      resumeId: null,
    });
    expect(ipc.agentPrompt).toHaveBeenCalledWith("s1", "hello");

    emit("t1", "s1", { type: "turnStarted", turnId: "T" });
    emit("t1", "s1", { type: "textDelta", turnId: "T", text: "Hi" });
    emit("t1", "other-session", { type: "textDelta", turnId: "T", text: "IGNORED" });
    const c = useAgentStore.getState().conversations.t1;
    expect(c.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(c.items[1]).toMatchObject({ text: "Hi" });

    // Second prompt reuses the session.
    await useAgentStore.getState().send("t1", "more");
    expect(ipc.agentStart).toHaveBeenCalledTimes(1);

    await useAgentStore.getState().stop("t1");
    expect(ipc.agentCancel).toHaveBeenCalledWith("s1");
  });

  it("permission cards call agentPermissionRespond and record the decision", async () => {
    await enableAi();
    await useAgentStore.getState().send("t1", "go");
    emit("t1", "s1", {
      type: "permissionRequest",
      turnId: "T",
      requestId: "r1",
      toolName: "github.search",
      title: "Search GitHub",
      detail: "query=x",
    });
    await useAgentStore.getState().respondPermission("t1", "r1", "allowForConversation");
    expect(ipc.agentPermissionRespond).toHaveBeenCalledWith("s1", "r1", "allowForConversation");
    const card = useAgentStore.getState().conversations.t1.items.find((i) => i.id === "r1");
    expect(card).toMatchObject({ kind: "permission", decision: "allowForConversation" });

    ipc.agentPermissionRespond.mockRejectedValueOnce({ kind: "other", message: "gone" });
    emit("t1", "s1", {
      type: "permissionRequest",
      turnId: "T",
      requestId: "r2",
      toolName: "x",
      title: "x",
      detail: null,
    });
    await useAgentStore.getState().respondPermission("t1", "r2", "deny");
    const card2 = useAgentStore.getState().conversations.t1.items.find((i) => i.id === "r2");
    expect(card2).toMatchObject({ decision: null });
  });

  it("calls the TurnController on turn start/end/exit and for Revert turn", async () => {
    const tc = {
      beginTurn: vi.fn(),
      endTurn: vi.fn(),
      revertTurn: vi.fn(async () => true),
    };
    setTurnController(tc);
    await enableAi();
    await useAgentStore.getState().send("t1", "go");
    emit("t1", "s1", { type: "turnStarted", turnId: "T" });
    expect(tc.beginTurn).toHaveBeenCalledWith("t1", "T");
    emit("t1", "s1", { type: "turnEnded", turnId: "T", stopReason: "endTurn", usage: null });
    expect(tc.endTurn).toHaveBeenCalledWith("t1", "T");

    await useAgentStore.getState().revertTurn("t1", "T");
    expect(tc.revertTurn).toHaveBeenCalledWith("t1", "T", { force: false });
    const marker = useAgentStore
      .getState()
      .conversations.t1.items.find((i) => i.kind === "turnEnd");
    expect(marker).toMatchObject({ revert: "reverted" });

    emit("t1", "s1", { type: "turnStarted", turnId: "T2" });
    emit("t1", "s1", { type: "exited", code: 1 });
    expect(tc.endTurn).toHaveBeenCalledWith("t1", "T2");
    expect(useAgentStore.getState().conversations.t1.sessionId).toBeNull();
  });

  it("hides Revert for turns without edits and asks before forcing a conflicting revert", async () => {
    const tc = {
      beginTurn: vi.fn(),
      endTurn: vi.fn((_tab: string, turnId: string) => (turnId === "empty" ? 0 : 2)),
      revertTurn: vi.fn(async (_t: string, _u: string, o?: { force?: boolean }) =>
        o?.force ? true : ("conflict" as const),
      ),
    };
    setTurnController(tc);
    await enableAi();
    await useAgentStore.getState().send("t1", "go");
    const marker = (turnId: string) =>
      useAgentStore
        .getState()
        .conversations.t1.items.find((i) => i.kind === "turnEnd" && i.turnId === turnId);
    for (const id of ["empty", "T"]) {
      emit("t1", "s1", { type: "turnStarted", turnId: id });
      emit("t1", "s1", { type: "turnEnded", turnId: id, stopReason: "endTurn", usage: null });
    }
    expect(marker("empty")).toMatchObject({ revert: "none" });
    expect(marker("T")).toMatchObject({ revert: "available" });

    await useAgentStore.getState().revertTurn("t1", "T");
    expect(marker("T")).toMatchObject({ revert: "conflict" });
    await useAgentStore.getState().revertTurn("t1", "T", true);
    expect(tc.revertTurn).toHaveBeenLastCalledWith("t1", "T", { force: true });
    expect(marker("T")).toMatchObject({ revert: "reverted" });
  });

  it("agentStart failure surfaces an actionable error", async () => {
    await enableAi();
    ipc.agentStart.mockRejectedValueOnce({ kind: "notLoggedIn", message: "auth" });
    await useAgentStore.getState().send("t1", "go");
    const c = useAgentStore.getState().conversations.t1;
    expect(c.status).toBe("error");
    expect(c.lastError).toEqual({ kind: "notLoggedIn", message: "auth" });
    expect(ipc.agentPrompt).not.toHaveBeenCalled();
  });

  it("attaching a folder restarts the session with the folder and resume id", async () => {
    await enableAi();
    await useAgentStore.getState().send("t1", "go");
    emit("t1", "s1", {
      type: "ready",
      engine: "copilot",
      version: "1",
      model: null,
      engineSessionId: "eng-1",
    });
    await useAgentStore.getState().setAttachedFolder("t1", "/Users/me/proj");
    expect(ipc.agentStop).toHaveBeenCalledWith("s1");
    ipc.agentStart.mockResolvedValueOnce("s2");
    await useAgentStore.getState().send("t1", "again");
    expect(ipc.agentStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ attachedFolder: "/Users/me/proj", resumeId: "eng-1" }),
    );
    // Late events from the retired session are ignored.
    emit("t1", "s1", { type: "turnStarted", turnId: "old" });
    expect(useAgentStore.getState().conversations.t1.currentTurnId).toBeNull();
  });

  it("closing a tab or turning AI off stops sessions", async () => {
    const dispose = installAgentStore();
    await enableAi();
    const tabA = useTabsStore.getState().newTab();
    await useAgentStore.getState().send(tabA, "go");
    useTabsStore.getState().closeTab(tabA);
    await vi.waitFor(() => expect(ipc.agentStop).toHaveBeenCalledWith("s1"));
    expect(useAgentStore.getState().conversations[tabA]).toBeUndefined();

    ipc.agentStart.mockResolvedValueOnce("s2");
    await useAgentStore.getState().send("t9", "go");
    useAgentStore.getState().setPanelOpen(true);
    await useSettingsStore.getState().setFlag("ai", false);
    await vi.waitFor(() => expect(ipc.agentStop).toHaveBeenCalledWith("s2"));
    expect(useAgentStore.getState().panelOpen).toBe(false);
    dispose();
  });
});
