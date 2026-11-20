import type { EngineKind } from "../../agent/types";

export interface EngineCaps {
  /** The model can change mid-conversation (Copilot ACP config option, Codex per-turn model). */
  liveModelSwitch: boolean;
}

/** Per-engine capabilities the panel needs. Claude `-p` fixes the model at launch. */
export const ENGINE_CAPS: Record<EngineKind, EngineCaps> = {
  copilot: { liveModelSwitch: true },
  codex: { liveModelSwitch: true },
  claude: { liveModelSwitch: false },
};
