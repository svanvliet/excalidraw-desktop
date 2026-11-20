import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { EngineKind, ModelOption } from "../../agent/types";
import { isLocked, useAgentStore, type Conversation } from "../../stores/agentStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { log } from "../../lib/logger";
import { ENGINE_META } from "./engineMeta";
import { ENGINE_CAPS } from "./engineCaps";

interface Props {
  tabId: string | null;
  conversation: Conversation;
  engine: EngineKind | null;
  available: EngineKind[];
  running: boolean;
  disabled: boolean;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function revealFolder(path: string) {
  import("@tauri-apps/plugin-opener")
    .then((m) => m.revealItemInDir(path))
    .catch((e) => log.warn("agent: reveal folder failed", e));
}

/**
 * Engine / model / folder of the active conversation. Engine and folder are
 * chosen before the first prompt, then fixed; the model stays switchable on
 * engines that support it (ENGINE_CAPS).
 */
export function AgentContextBar({
  tabId,
  conversation,
  engine,
  available,
  running,
  disabled,
}: Props) {
  const known = useAgentStore((s) => (engine ? s.knownModels[engine] : undefined));
  const probing = useAgentStore((s) => (engine ? !!s.probingModels[engine] : false));
  const settingsModel = useSettingsStore((s) => (engine ? s.aiEngines[engine].model.trim() : ""));
  const store = useAgentStore.getState;
  const locked = isLocked(conversation);

  const reported = conversation.availableModels.length > 0 ? conversation.availableModels : known;
  const current = conversation.model ?? conversation.requestedModel ?? null;
  const options: ModelOption[] = [...(reported ?? [])];
  for (const id of [current, settingsModel || null]) {
    if (id && !options.some((o) => o.id === id)) options.push({ id, name: null });
  }
  const modelEditable =
    !!tabId && !!engine && !disabled && (!locked || ENGINE_CAPS[engine].liveModelSwitch);
  const defaultLabel = settingsModel ? `Default (${settingsModel})` : "Engine default";

  const pickFolder = async () => {
    if (!tabId) return;
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") await store().setAttachedFolder(tabId, picked);
    } catch (e) {
      log.warn("agent: attach folder failed", e);
    }
  };

  const folder = conversation.attachedFolder;

  return (
    <div className="agent-context" data-testid="agent-context">
      <span className="agent-context__label">Engine</span>
      <span className="agent-context__value">
        {!locked && tabId && available.length > 0 ? (
          <select
            className="agent-panel__engine"
            aria-label="Agent engine"
            value={engine ?? ""}
            onChange={(e) => void store().selectEngine(tabId, e.target.value as EngineKind)}
            disabled={disabled || running}
            data-testid="agent-engine-select"
          >
            {available.map((e) => (
              <option key={e} value={e}>
                {ENGINE_META[e].label}
              </option>
            ))}
          </select>
        ) : (
          <span
            title="The engine is fixed for this conversation. Start a new one to switch."
            data-testid="agent-engine"
          >
            {engine ? ENGINE_META[engine].label : "None"}
          </span>
        )}
      </span>

      <span className="agent-context__label">Model</span>
      <span className="agent-context__value">
        {modelEditable && tabId && (options.length > 0 || !locked) ? (
          <select
            className="agent-panel__engine"
            aria-label="Model"
            value={current ?? ""}
            onChange={(e) => void store().setModel(tabId, e.target.value || null)}
            disabled={running}
            data-testid="agent-model-select"
          >
            {!locked || !current ? <option value="">{defaultLabel}</option> : null}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name ?? o.id}
              </option>
            ))}
            {options.length === 0 ? (
              <option value="__none" disabled>
                {probing ? "Loading models…" : "No other models reported"}
              </option>
            ) : null}
          </select>
        ) : (
          <span
            title={
              locked && engine && !ENGINE_CAPS[engine].liveModelSwitch
                ? `${ENGINE_META[engine].label} can't change models mid-conversation.`
                : "The model list appears once the engine has started."
            }
            data-testid="agent-model"
          >
            {current ?? (locked ? "Engine default" : defaultLabel)}
          </span>
        )}
      </span>

      <span className="agent-context__label">Folder</span>
      <span className="agent-context__value agent-context__folder">
        <span
          className="agent-context__path"
          title={folder ?? "The agent only sees this canvas."}
          data-testid="agent-folder"
        >
          {folder ? `${folderName(folder)} (read-only)` : "None — canvas only"}
        </span>
        {!locked ? (
          <>
            <button
              type="button"
              className="agent-context__link"
              onClick={() => void pickFolder()}
              disabled={disabled || running}
              title="Let the agent read a folder (read-only)"
              data-testid="agent-attach"
            >
              {folder ? "Change…" : "Attach…"}
            </button>
            {folder ? (
              <button
                type="button"
                className="agent-context__link"
                onClick={() => tabId && void store().setAttachedFolder(tabId, null)}
                disabled={disabled || running}
                data-testid="agent-detach"
              >
                Detach
              </button>
            ) : null}
          </>
        ) : null}
        {folder ? (
          <button
            type="button"
            className="agent-context__link"
            onClick={() => revealFolder(folder)}
            title={folder}
            data-testid="agent-reveal"
          >
            Reveal
          </button>
        ) : null}
      </span>
    </div>
  );
}
