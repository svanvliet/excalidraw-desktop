import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../stores/settingsStore";
import { installAgentRuntime } from "./runtime";

// The real modules pull in Excalidraw, which needs a canvas jsdom doesn't provide.
vi.mock("./scene/turns", () => ({ beginTurn: vi.fn(), endTurn: vi.fn(), revertTurn: vi.fn() }));
vi.mock("./toolExecutor", () => ({ startToolExecutor: vi.fn() }));

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("installAgentRuntime", () => {
  afterEach(() => useSettingsStore.setState({ ai: false }));

  it("runs the tool executor only while AI is enabled", async () => {
    useSettingsStore.setState({ ai: false });
    const unlisten = vi.fn();
    const start = vi.fn(async () => unlisten);
    const dispose = installAgentRuntime(start);
    await flush();
    expect(start).not.toHaveBeenCalled();

    useSettingsStore.setState({ ai: true });
    await flush();
    expect(start).toHaveBeenCalledTimes(1);

    useSettingsStore.setState({ ai: false });
    expect(unlisten).toHaveBeenCalledTimes(1);

    useSettingsStore.setState({ ai: true });
    await flush();
    dispose();
    expect(start).toHaveBeenCalledTimes(2);
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
