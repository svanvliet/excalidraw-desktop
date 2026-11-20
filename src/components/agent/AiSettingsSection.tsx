/**
 * Settings → AI (docs/ai-integration.md § UX, FR-27/28/32, D-AI5/D-AI6).
 * Detection only runs while the `ai` toggle is on.
 */
import { useEffect } from "react";
import type { EngineKind } from "../../agent/types";
import { ENGINE_KINDS, useSettingsStore } from "../../stores/settingsStore";
import { loadKnownModelsFor, useAgentStore } from "../../stores/agentStore";
import { ENGINE_META, engineStatusText } from "./engineMeta";
import { RefreshIcon } from "../icons";

export function AiSettingsSection() {
  const ai = useSettingsStore((s) => s.ai);
  const aiEngines = useSettingsStore((s) => s.aiEngines);
  const defaultEngine = useSettingsStore((s) => s.aiDefaultEngine);
  const setEngineSettings = useSettingsStore((s) => s.setEngineSettings);
  const setDefaultEngine = useSettingsStore((s) => s.setDefaultEngine);
  const engines = useAgentStore((s) => s.engines);
  const detecting = useAgentStore((s) => s.detecting);
  const detect = useAgentStore((s) => s.detect);
  const knownModels = useAgentStore((s) => s.knownModels);

  useEffect(() => {
    if (!ai) return;
    void detect();
    for (const e of ENGINE_KINDS) void loadKnownModelsFor(e);
  }, [ai, detect]);

  return (
    <section className="settings__section" data-testid="settings-ai">
      <h3>AI agent</h3>
      <p className="settings__hint">
        Uses an AI agent you already have installed and signed in to — GitHub Copilot CLI, Claude
        Code, or OpenAI Codex. The app never asks for or stores API keys; it can only read and edit
        the canvas through its own tools, and the agent&apos;s shell and file-write tools are always
        off. The ChatGPT and Copilot desktop apps can&apos;t be driven by other apps — install the
        Codex CLI or Copilot CLI instead.
      </p>

      {!ai ? (
        <p className="settings__hint" data-testid="ai-off-hint">
          Turn on <strong>AI agent</strong> above to detect installed agents.
        </p>
      ) : (
        <>
          <div className="ai-settings__toolbar">
            <label className="settings__field ai-settings__default">
              <span>Default engine</span>
              <select
                value={defaultEngine}
                onChange={(e) => void setDefaultEngine(e.target.value as EngineKind)}
                data-testid="ai-default-engine"
              >
                {ENGINE_KINDS.map((e) => (
                  <option key={e} value={e}>
                    {ENGINE_META[e].label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void detect()}
              disabled={detecting}
              data-testid="ai-redetect"
            >
              <RefreshIcon />
              <span>{detecting ? "Detecting…" : "Re-detect"}</span>
            </button>
          </div>

          {ENGINE_KINDS.map((engine) => {
            const meta = ENGINE_META[engine];
            const info = engines.find((i) => i.engine === engine);
            const cfg = aiEngines[engine];
            const status = info?.status ?? "unknown";
            return (
              <div
                key={engine}
                className="ai-engine"
                data-status={status}
                data-testid={`ai-engine-${engine}`}
              >
                <div className="ai-engine__header">
                  <label className="ai-engine__enable">
                    <input
                      type="checkbox"
                      className="switch"
                      checked={cfg.enabled}
                      onChange={(e) =>
                        void setEngineSettings(engine, { enabled: e.target.checked })
                      }
                      aria-label={`Enable ${meta.label}`}
                      data-testid={`ai-enable-${engine}`}
                    />
                    <strong>{meta.label}</strong>
                  </label>
                  <span className="ai-engine__status" data-testid={`ai-status-${engine}`}>
                    {engineStatusText(info)}
                  </span>
                </div>
                {info?.path ? <code className="ai-engine__path">{info.path}</code> : null}
                {status === "notLoggedIn" ? (
                  <span className="settings__hint">
                    Sign in from a terminal: <code className="ai-engine__cmd">{meta.signIn}</code>
                  </span>
                ) : null}
                {status === "notFound" ? (
                  <span className="settings__hint">
                    Install it from <code className="ai-engine__cmd">{meta.installUrl}</code>
                  </span>
                ) : null}
                {info?.message && status !== "unknown" ? (
                  <span className="settings__hint">{info.message}</span>
                ) : null}

                <label className="settings__row">
                  <input
                    type="checkbox"
                    className="switch"
                    checked={cfg.useHostConfig}
                    onChange={(e) =>
                      void setEngineSettings(engine, { useHostConfig: e.target.checked })
                    }
                    data-testid={`ai-hostconfig-${engine}`}
                  />
                  <span className="settings__row-text">
                    <strong>Use my agent&apos;s MCPs, skills &amp; plugins</strong>
                    <span className="settings__hint">
                      Loads your own {meta.label} configuration. Tools from it that might change
                      things ask for your approval first.
                    </span>
                  </span>
                </label>

                <div className="ai-engine__fields">
                  <label className="settings__field">
                    <span>Custom path</span>
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={cfg.pathOverride}
                      onChange={(e) =>
                        void setEngineSettings(engine, { pathOverride: e.target.value })
                      }
                      placeholder="Auto-detect"
                      data-testid={`ai-path-${engine}`}
                    />
                  </label>
                  <label className="settings__field">
                    <span>Model</span>
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={cfg.model}
                      onChange={(e) => void setEngineSettings(engine, { model: e.target.value })}
                      placeholder="Engine default"
                      list={`ai-models-${engine}`}
                      data-testid={`ai-model-${engine}`}
                    />
                    <datalist id={`ai-models-${engine}`}>
                      {(knownModels[engine] ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name ?? m.id}
                        </option>
                      ))}
                    </datalist>
                  </label>
                </div>
              </div>
            );
          })}
        </>
      )}

      <p className="settings__hint" data-testid="ai-terms">
        Your GitHub Copilot, Anthropic, or OpenAI terms apply to how you use their agent.
      </p>
    </section>
  );
}
