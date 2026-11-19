import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UpdateState } from "../ipc/commands";

const ipc = vi.hoisted(() => ({
  updateCheck: vi.fn<(manual: boolean) => Promise<UpdateState>>(),
}));

vi.mock("../ipc/commands", async (orig) => {
  const actual = await orig<typeof import("../ipc/commands")>();
  return { ...actual, updateCheck: (m: boolean) => ipc.updateCheck(m) };
});
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

import { UPDATE_STATE_UNAVAILABLE } from "../ipc/commands";
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  __resetUpdateStoreForTests,
  selectShowReady,
  startUpdateScheduler,
  useUpdateStore,
} from "./updateStore";
import { __resetSettingsForTests, useSettingsStore } from "./settingsStore";

describe("update scheduler", () => {
  let stop: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    __resetSettingsForTests();
    __resetUpdateStoreForTests();
    ipc.updateCheck.mockReset().mockResolvedValue({
      ...UPDATE_STATE_UNAVAILABLE,
      status: "upToDate",
    });
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("never checks before the user consents", async () => {
    stop = startUpdateScheduler();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(ipc.updateCheck).not.toHaveBeenCalled();
  });

  it("checks after the first delay and then on the interval once consented", async () => {
    useSettingsStore.setState({ autoUpdate: true });
    stop = startUpdateScheduler();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(ipc.updateCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ipc.updateCheck).toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(ipc.updateCheck).toHaveBeenCalledTimes(2);
  });

  it("starts when consent is granted at runtime and stops when revoked", async () => {
    stop = startUpdateScheduler();
    useSettingsStore.setState({ autoUpdate: true });
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(ipc.updateCheck).toHaveBeenCalledTimes(1);
    useSettingsStore.setState({ autoUpdate: false });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(ipc.updateCheck).toHaveBeenCalledTimes(1);
  });

  it("manual checks bypass consent and surface errors", async () => {
    await useUpdateStore.getState().checkNow();
    expect(ipc.updateCheck).toHaveBeenCalledWith(true);
    expect(useUpdateStore.getState().status).toBe("upToDate");
  });

  it("'Later' hides the banner only for the dismissed version", () => {
    useUpdateStore.setState({ status: "ready", version: "1.2.0" });
    expect(selectShowReady(useUpdateStore.getState())).toBe(true);
    useUpdateStore.getState().dismiss();
    expect(selectShowReady(useUpdateStore.getState())).toBe(false);
    useUpdateStore.setState({ version: "1.3.0" });
    expect(selectShowReady(useUpdateStore.getState())).toBe(true);
  });
});
