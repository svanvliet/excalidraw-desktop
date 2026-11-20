import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentEventEnvelope, EngineInfo } from "../../agent/types";

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

const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

const ipc = vi.hoisted(() => ({
  agentDetect: vi.fn(),
  agentStart: vi.fn(),
  agentPrompt: vi.fn(),
  agentCancel: vi.fn(),
  agentPermissionRespond: vi.fn(),
  agentStop: vi.fn(),
  agentSetModel: vi.fn(),
}));
vi.mock("../../ipc/commands", () => ipc);

const events = vi.hoisted(() => ({
  handler: null as null | ((e: AgentEventEnvelope) => void),
}));
vi.mock("../../ipc/agentEvents", () => ({
  onAgentEvent: vi.fn(async (h: (e: AgentEventEnvelope) => void) => {
    events.handler = h;
    return () => {};
  }),
}));

import { AgentPanel } from "./AgentPanel";
import { __resetAgentStoreForTests, useAgentStore } from "../../stores/agentStore";
import { __resetSettingsForTests, useSettingsStore } from "../../stores/settingsStore";

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
    engine: "codex",
    status: "ready",
    path: "/bin/codex",
    version: "0.50.0",
    minVersion: "0.40.0",
    message: null,
  },
];

function emit(event: AgentEventEnvelope["event"]) {
  act(() => events.handler?.({ sessionId: "s1", tabId: "t1", event }));
}

async function openPanel({ accepted = true } = {}) {
  await useSettingsStore.getState().setFlag("ai", true);
  if (accepted) await useSettingsStore.getState().acceptAiDisclosure("copilot");
  useAgentStore.getState().setPanelOpen(true);
}

beforeEach(() => {
  __resetSettingsForTests();
  __resetAgentStoreForTests();
  events.handler = null;
  dialog.open.mockReset();
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.agentDetect.mockResolvedValue(READY);
  ipc.agentStart.mockResolvedValue("s1");
  ipc.agentPrompt.mockResolvedValue("T1");
  ipc.agentCancel.mockResolvedValue(undefined);
  ipc.agentPermissionRespond.mockResolvedValue(undefined);
  ipc.agentStop.mockResolvedValue(undefined);
  ipc.agentSetModel.mockResolvedValue(undefined);
});

describe("AgentPanel", () => {
  it("renders nothing and calls no agent IPC while AI is off", () => {
    useAgentStore.getState().setPanelOpen(true);
    const { container } = render(<AgentPanel tabId="t1" />);
    expect(container).toBeEmptyDOMElement();
    expect(ipc.agentDetect).not.toHaveBeenCalled();
    expect(ipc.agentStart).not.toHaveBeenCalled();
  });

  it("detects engines on open, lists ready engines, and shows the plan footer", async () => {
    await openPanel();
    render(<AgentPanel tabId="t1" />);
    await waitFor(() => expect(screen.getByTestId("agent-engine-select")).toBeInTheDocument());
    expect(ipc.agentDetect).toHaveBeenCalledTimes(1);
    const options = within(screen.getByTestId("agent-engine-select"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["GitHub Copilot CLI", "OpenAI Codex"]);
    expect(screen.getByTestId("agent-model-select")).toBeTruthy();
    expect(screen.getByTestId("agent-footer")).toHaveTextContent("Uses your GitHub Copilot plan");
  });

  it("Enter sends, Shift+Enter does not; streams the reply and shows Stop while running", async () => {
    await openPanel();
    render(<AgentPanel tabId="t1" />);
    await waitFor(() => expect(screen.getByTestId("agent-engine-select")).toBeInTheDocument());
    const input = screen.getByTestId<HTMLTextAreaElement>("agent-input");

    fireEvent.change(input, { target: { value: "draw a box" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(ipc.agentStart).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledWith("s1", "draw a box"));
    expect(input.value).toBe("");
    expect(ipc.agentStart).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "t1", engine: "copilot", useHostConfig: true }),
    );
    expect(screen.getByTestId("agent-msg-user")).toHaveTextContent("draw a box");

    emit({ type: "turnStarted", turnId: "T1" });
    emit({ type: "textDelta", turnId: "T1", text: "Here is **a box**" });
    expect(screen.getByTestId("agent-transcript")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("agent-msg-assistant").querySelector("strong")).toHaveTextContent(
      "a box",
    );
    fireEvent.click(screen.getByTestId("agent-stop"));
    await waitFor(() => expect(ipc.agentCancel).toHaveBeenCalledWith("s1"));

    emit({
      type: "turnEnded",
      turnId: "T1",
      stopReason: "cancelled",
      usage: { inputTokens: 100, outputTokens: 20, premiumRequests: 1 },
    });
    expect(screen.getByTestId("agent-send")).toBeInTheDocument();
    expect(screen.getByTestId("agent-turn-end")).toHaveTextContent("Stopped");
    expect(screen.getByTestId("agent-footer")).toHaveTextContent("1 premium request · 120 tokens");
  });

  it("shows the streaming cursor only on the newest reply in a turn", async () => {
    await openPanel();
    render(<AgentPanel tabId="t1" />);
    await waitFor(() => expect(screen.getByTestId("agent-engine-select")).toBeInTheDocument());
    const input = screen.getByTestId<HTMLTextAreaElement>("agent-input");
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());

    const tool = {
      type: "toolCall" as const,
      turnId: "T1",
      callId: "c1",
      name: "add_elements",
      title: null,
      source: "canvas" as const,
      input: {},
      output: "ok",
      status: "completed" as const,
    };
    emit({ type: "turnStarted", turnId: "T1" });
    emit({ type: "textDelta", turnId: "T1", text: "first" });
    emit(tool);
    emit({ type: "textDelta", turnId: "T1", text: "second" });
    const replies = screen.getAllByTestId("agent-msg-assistant");
    expect(replies).toHaveLength(2);
    expect(replies[0].querySelector(".agent-cursor")).toBeNull();
    expect(replies[1].querySelector(".agent-cursor")).not.toBeNull();

    emit({ ...tool, callId: "c2", status: "running", output: null });
    expect(document.querySelectorAll(".agent-cursor")).toHaveLength(0);
  });

  it("permission card buttons respond and then show the decision", async () => {
    await openPanel();
    render(<AgentPanel tabId="t1" />);
    await waitFor(() => expect(screen.getByTestId("agent-engine-select")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("agent-input"), { target: { value: "go" } });
    fireEvent.click(screen.getByTestId("agent-send"));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());

    emit({ type: "turnStarted", turnId: "T1" });
    emit({
      type: "permissionRequest",
      turnId: "T1",
      requestId: "r1",
      toolName: "github.create_issue",
      title: "Create an issue in octo/repo",
      detail: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Allow for this conversation" }));
    await waitFor(() =>
      expect(ipc.agentPermissionRespond).toHaveBeenCalledWith("s1", "r1", "allowForConversation"),
    );
    expect(screen.getByTestId("agent-permission")).toHaveTextContent(
      "Allowed for this conversation",
    );
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("first use shows the privacy disclosure; Continue persists it and sends", async () => {
    await openPanel({ accepted: false });
    render(<AgentPanel tabId="t1" />);
    await waitFor(() => expect(screen.getByTestId("agent-engine-select")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("agent-input"), { target: { value: "hi" } });
    fireEvent.click(screen.getByTestId("agent-send"));
    await waitFor(() => expect(screen.getByTestId("agent-disclosure")).toBeInTheDocument());
    expect(screen.getByTestId("agent-disclosure")).toHaveTextContent(
      "sent to GitHub under your GitHub Copilot CLI account",
    );
    expect(ipc.agentStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("agent-disclosure-accept"));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledWith("s1", "hi"));
    expect(useSettingsStore.getState().aiDisclosureAccepted.copilot).toBe(true);
  });

  it("viewer tabs get a disabled message and composer", async () => {
    await openPanel();
    render(<AgentPanel tabId="t1" readOnly />);
    expect(screen.getByTestId("agent-readonly")).toBeInTheDocument();
    expect(screen.getByTestId("agent-input")).toBeDisabled();
  });

  it("shows the collab indicator and guidance when no engine is ready", async () => {
    ipc.agentDetect.mockResolvedValue([{ ...READY[0], status: "notLoggedIn" }]);
    await openPanel();
    const onOpenSettings = vi.fn();
    render(<AgentPanel tabId="t1" collabParticipants={2} onOpenSettings={onOpenSettings} />);
    expect(screen.getByTestId("agent-collab")).toHaveTextContent(
      "Edits are shared with 2 participants",
    );
    await waitFor(() => expect(screen.getByTestId("agent-no-engine")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Open Settings/ }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.getByTestId("agent-input")).toBeDisabled();
  });

  it("Folder row attaches and detaches before the first prompt, then locks", async () => {
    dialog.open.mockResolvedValue("/Users/me/project");
    await openPanel();
    render(<AgentPanel tabId="t1" />);
    await waitFor(() => expect(screen.getByTestId("agent-engine-select")).toBeInTheDocument());
    expect(screen.getByTestId("agent-folder")).toHaveTextContent("canvas only");
    fireEvent.click(screen.getByTestId("agent-attach"));
    await waitFor(() => expect(screen.getByTestId("agent-folder")).toHaveTextContent("project"));
    expect(dialog.open).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(useAgentStore.getState().conversations.t1.attachedFolder).toBe("/Users/me/project");
    fireEvent.click(screen.getByTestId("agent-detach"));
    await waitFor(() =>
      expect(screen.getByTestId("agent-folder")).toHaveTextContent("canvas only"),
    );

    fireEvent.click(screen.getByTestId("agent-attach"));
    await waitFor(() => expect(screen.getByTestId("agent-folder")).toHaveTextContent("project"));
    fireEvent.change(screen.getByTestId("agent-input"), { target: { value: "hi" } });
    fireEvent.click(screen.getByTestId("agent-send"));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalled());
    expect(screen.queryByTestId("agent-attach")).toBeNull();
    expect(screen.queryByTestId("agent-detach")).toBeNull();
    expect(screen.getByTestId("agent-reveal")).toBeInTheDocument();
  });

  it("locks the engine after the first prompt and keeps a live model picker", async () => {
    await openPanel();
    render(<AgentPanel tabId="t1" />);
    await waitFor(() => expect(screen.getByTestId("agent-engine-select")).toBeInTheDocument());
    expect(screen.queryByTestId("agent-new")).toBeNull();
    fireEvent.change(screen.getByTestId("agent-input"), { target: { value: "hi" } });
    fireEvent.click(screen.getByTestId("agent-send"));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(screen.queryByTestId("agent-engine-select")).toBeNull();
    expect(screen.getByTestId("agent-engine")).toHaveTextContent("GitHub Copilot");

    emit({ type: "ready", engine: "copilot", version: "1", model: "gpt-5", engineSessionId: "e1" });
    emit({
      type: "models",
      available: [
        { id: "gpt-5", name: "GPT-5" },
        { id: "claude-sonnet", name: "Claude Sonnet" },
      ],
    });
    const picker = await screen.findByTestId("agent-model-select");
    expect(picker).toHaveValue("gpt-5");
    fireEvent.change(picker, { target: { value: "claude-sonnet" } });
    await waitFor(() => expect(ipc.agentSetModel).toHaveBeenCalledWith("s1", "claude-sonnet"));
  });

  it("conversation menu starts a new conversation and reopens an earlier one", async () => {
    await openPanel();
    render(<AgentPanel tabId="t1" />);
    await waitFor(() => expect(screen.getByTestId("agent-engine-select")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("agent-input"), { target: { value: "Draw a cat" } });
    fireEvent.click(screen.getByTestId("agent-send"));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(screen.getByTestId("agent-conversations")).toHaveTextContent("Draw a cat");
    emit({ type: "turnStarted", turnId: "T1" });
    emit({ type: "turnEnded", turnId: "T1", stopReason: "endTurn", usage: null });

    fireEvent.click(screen.getByTestId("agent-conversations"));
    fireEvent.click(screen.getByTestId("agent-new"));
    await waitFor(() =>
      expect(screen.getByTestId("agent-conversations")).toHaveTextContent("New conversation"),
    );
    expect(screen.getByTestId("agent-engine-select")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("agent-conversations"));
    const items = screen.getAllByTestId("agent-conversation-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Draw a cat");
    fireEvent.click(items[0]);
    await waitFor(() =>
      expect(screen.getByTestId("agent-conversations")).toHaveTextContent("Draw a cat"),
    );
    expect(screen.getByTestId("agent-transcript")).toHaveTextContent("Draw a cat");
  });

  it("Close hides the panel", async () => {
    await openPanel();
    render(<AgentPanel tabId="t1" />);
    fireEvent.click(screen.getByTestId("agent-close"));
    expect(useAgentStore.getState().panelOpen).toBe(false);
    expect(screen.queryByTestId("agent-panel")).toBeNull();
  });
});
