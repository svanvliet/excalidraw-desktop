/**
 * Connects the agent store to the canvas: per-turn undo grouping / Revert turn (scene/turns.ts)
 * and the `agent://tool-call` executor. The executor only listens while AI is enabled (SEC-3).
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import { log } from "../lib/logger";
import { setTurnController, type TurnController } from "../stores/agentStore";
import { useSettingsStore } from "../stores/settingsStore";
import { beginTurn, endTurn, revertTurn } from "./scene/turns";
import { startToolExecutor } from "./toolExecutor";

export const sceneTurnController: TurnController = {
  beginTurn,
  endTurn,
  revertTurn(tabId, turnId, opts) {
    const r = revertTurn(tabId, turnId, opts);
    if (r.ok) return true;
    if (r.reason === "conflict") return "conflict";
    log.warn(`agent: revert turn ${turnId} failed (${r.reason})`);
    return false;
  },
};

export function installAgentRuntime(
  start: () => Promise<UnlistenFn> = startToolExecutor,
): () => void {
  setTurnController(sceneTurnController);
  let unlisten: UnlistenFn | null = null;
  let starting: Promise<void> | null = null;
  let disposed = false;

  const sync = (enabled: boolean) => {
    if (enabled && !unlisten && !starting) {
      starting = start()
        .then((u) => {
          if (disposed || !useSettingsStore.getState().ai) u();
          else unlisten = u;
        })
        .catch((e: unknown) => log.error("agent: tool executor failed to start", e))
        .finally(() => {
          starting = null;
        });
    } else if (!enabled && unlisten) {
      unlisten();
      unlisten = null;
    }
  };

  sync(useSettingsStore.getState().ai);
  const unsub = useSettingsStore.subscribe((s, prev) => {
    if (s.ai !== prev.ai) sync(s.ai);
  });
  return () => {
    disposed = true;
    unsub();
    unlisten?.();
    unlisten = null;
    setTurnController(null);
  };
}
