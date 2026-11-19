import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-store", () => {
  const byPath = new Map<string, Map<string, unknown>>();
  class FakeStore {
    private data: Map<string, unknown>;
    constructor(path: string) {
      let bucket = byPath.get(path);
      if (!bucket) {
        bucket = new Map();
        byPath.set(path, bucket);
      }
      this.data = bucket;
    }
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

const agentDetect = vi.hoisted(() => vi.fn());
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  agentDetect,
}));

import { SettingsDialog } from "./SettingsDialog";
import { __resetAgentStoreForTests } from "../stores/agentStore";
import { useSettingsStore, __resetSettingsForTests } from "../stores/settingsStore";
import { LazyStore } from "@tauri-apps/plugin-store";

describe("SettingsDialog", () => {
  beforeEach(async () => {
    __resetSettingsForTests();
    __resetAgentStoreForTests();
    agentDetect.mockReset();
    agentDetect.mockResolvedValue([
      {
        engine: "copilot",
        status: "ready",
        path: "/usr/local/bin/copilot",
        version: "1.2.3",
        minVersion: "1.0.0",
        message: null,
      },
      {
        engine: "claude",
        status: "notLoggedIn",
        path: "/usr/local/bin/claude",
        version: "2.0.0",
        minVersion: "1.0.0",
        message: null,
      },
      {
        engine: "codex",
        status: "notFound",
        path: null,
        version: null,
        minVersion: "0.40.0",
        message: null,
      },
    ]);
    const wipe = new LazyStore("settings.json");
    await wipe.set("settings", undefined);
    await wipe.save();
  });

  it("does not render when open is false", () => {
    render(<SettingsDialog open={false} onClose={() => {}} />);
    expect(screen.queryByText("Settings")).toBeNull();
  });

  it("shows all three online-feature toggles in the off position by default", () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    expect(screen.getByTestId<HTMLInputElement>("toggle-collab").checked).toBe(false);
    expect(screen.getByTestId<HTMLInputElement>("toggle-library").checked).toBe(false);
    expect(screen.getByTestId<HTMLInputElement>("toggle-ai").checked).toBe(false);
  });

  it("toggling a feature persists to the store", async () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("toggle-ai"));
    await waitFor(() => expect(useSettingsStore.getState().ai).toBe(true));
  });

  it("has no API key field anywhere (SEC-3)", () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    expect(screen.queryByTestId("secret-openai")).toBeNull();
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/sk-/)).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("AI off: no detection runs and engine cards are hidden", () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    expect(screen.getByTestId("ai-off-hint")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-engine-copilot")).toBeNull();
    expect(agentDetect).not.toHaveBeenCalled();
    expect(screen.getByTestId("ai-terms")).toHaveTextContent(/terms apply/);
  });

  it("AI on: detects engines, shows status + sign-in guidance, and edits engine settings", async () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("toggle-ai"));
    await waitFor(() => expect(agentDetect).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("ai-status-copilot")).toHaveTextContent("Ready — v1.2.3"),
    );
    expect(screen.getByTestId("ai-status-claude")).toHaveTextContent(/Not signed in/);
    expect(screen.getByTestId("ai-engine-claude")).toHaveTextContent("claude, then /login");
    expect(screen.getByTestId("ai-status-codex")).toHaveTextContent(/Not found/);
    expect(screen.getByText(/can't be driven by other apps/)).toBeInTheDocument();

    expect(screen.getByTestId<HTMLInputElement>("ai-hostconfig-codex").checked).toBe(true);
    fireEvent.click(screen.getByTestId("ai-hostconfig-codex"));
    fireEvent.click(screen.getByTestId("ai-enable-claude"));
    fireEvent.change(screen.getByTestId("ai-path-codex"), { target: { value: "/opt/codex" } });
    fireEvent.change(screen.getByTestId("ai-model-copilot"), { target: { value: "gpt-5" } });
    fireEvent.change(screen.getByTestId("ai-default-engine"), { target: { value: "codex" } });
    await waitFor(() => {
      const s = useSettingsStore.getState();
      expect(s.aiEngines.codex).toMatchObject({ useHostConfig: false, pathOverride: "/opt/codex" });
      expect(s.aiEngines.claude.enabled).toBe(false);
      expect(s.aiEngines.copilot.model).toBe("gpt-5");
      expect(s.aiDefaultEngine).toBe("codex");
    });

    fireEvent.click(screen.getByTestId("ai-redetect"));
    await waitFor(() => expect(agentDetect).toHaveBeenCalledTimes(2));
    expect(agentDetect).toHaveBeenLastCalledWith([{ engine: "codex", path: "/opt/codex" }]);
  });

  it("Reset all puts every toggle back to its default", async () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("toggle-collab"));
    await waitFor(() => expect(useSettingsStore.getState().collab).toBe(true));

    fireEvent.click(screen.getByTestId("settings-reset"));
    await waitFor(() => expect(useSettingsStore.getState().collab).toBe(false));
  });

  it("has no Firebase field and explains end-to-end encryption", () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    expect(screen.queryByText(/firebase/i)).toBeNull();
    expect(screen.getByText(/end-to-end encrypted/i)).toBeInTheDocument();
  });

  it("edits display name and tunnel mode; manual URL field only shows in manual mode", async () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    expect(screen.getByTestId<HTMLInputElement>("collab-tunnel-auto").checked).toBe(true);
    expect(screen.queryByTestId("collab-manual-url")).toBeNull();

    fireEvent.change(screen.getByTestId("collab-display-name"), { target: { value: "Ada" } });
    await waitFor(() => expect(useSettingsStore.getState().collabDisplayName).toBe("Ada"));

    fireEvent.click(screen.getByTestId("collab-tunnel-manual"));
    await waitFor(() => expect(useSettingsStore.getState().collabTunnelMode).toBe("manual"));
    const url = screen.getByTestId("collab-manual-url");
    fireEvent.change(url, { target: { value: "ftp://nope" } });
    expect(screen.getByText(/http:\/\/ or https:\/\//)).toBeInTheDocument();
    fireEvent.change(url, { target: { value: "https://t.example.com" } });
    await waitFor(() =>
      expect(useSettingsStore.getState().collabManualUrl).toBe("https://t.example.com"),
    );
    expect(screen.queryByText(/http:\/\/ or https:\/\//)).toBeNull();

    fireEvent.click(screen.getByTestId("collab-tunnel-local"));
    await waitFor(() => expect(useSettingsStore.getState().collabTunnelMode).toBe("local"));
    expect(screen.queryByTestId("collab-manual-url")).toBeNull();
  });

  it("only commits valid ports and flags invalid input", async () => {
    render(<SettingsDialog open={true} onClose={() => {}} />);
    const port = screen.getByTestId<HTMLInputElement>("collab-port");
    expect(port.value).toBe("4780");
    fireEvent.change(port, { target: { value: "80" } });
    expect(screen.getByText(/between 1024 and 65535/)).toBeInTheDocument();
    expect(useSettingsStore.getState().collabPort).toBe(4780);
    fireEvent.change(port, { target: { value: "5001" } });
    await waitFor(() => expect(useSettingsStore.getState().collabPort).toBe(5001));
    expect(screen.queryByText(/between 1024 and 65535/)).toBeNull();
  });

  it("Done invokes onClose", () => {
    const onClose = vi.fn();
    render(<SettingsDialog open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("settings-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape key invokes onClose while the dialog is open", () => {
    const onClose = vi.fn();
    render(<SettingsDialog open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop click invokes onClose; the dialog body click does not", () => {
    const onClose = vi.fn();
    render(<SettingsDialog open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("settings-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Settings"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
