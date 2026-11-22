/**
 * Static, user-facing metadata about each supported agent engine
 * (docs/ai-integration.md § UX). No IPC here.
 */
import type { EngineInfo, EngineKind, ErrorKind, Usage } from "../../agent/types";

export interface EngineMeta {
  label: string;
  /** Who receives prompts under the user's account (FR-33 disclosure). */
  provider: string;
  /** Account/plan name shown in "Uses your … plan". */
  plan: string;
  /** Copyable sign-in command. */
  signIn: string;
  installUrl: string;
}

export const ENGINE_META: Record<EngineKind, EngineMeta> = {
  copilot: {
    label: "GitHub Copilot CLI",
    provider: "GitHub",
    plan: "GitHub Copilot",
    signIn: "copilot login",
    installUrl: "https://docs.github.com/copilot/how-tos/set-up/install-copilot-cli",
  },
  claude: {
    label: "Claude Code",
    provider: "Anthropic",
    plan: "Claude",
    signIn: "claude, then /login",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
  },
  codex: {
    label: "OpenAI Codex",
    provider: "OpenAI",
    plan: "ChatGPT",
    signIn: "codex login",
    installUrl: "https://github.com/openai/codex",
  },
};

export function disclosureText(engine: EngineKind): string {
  const m = ENGINE_META[engine];
  return `Prompts, the canvas content the agent reads, and attached-folder files are sent to ${m.provider} under your ${m.label} account.`;
}

/** One-line status text for a detected engine (Settings → AI). */
export function engineStatusText(info: EngineInfo | undefined): string {
  if (!info) return "Not detected yet";
  const m = ENGINE_META[info.engine];
  switch (info.status) {
    case "ready":
      return `Ready${info.version ? ` — v${info.version}` : ""}`;
    case "notFound":
      return "Not found — install it, or set a custom path";
    case "notLoggedIn":
      return `Not signed in — run \`${m.signIn}\` in a terminal`;
    case "unsupportedVersion":
      return `Unsupported version${info.version ? ` (v${info.version})` : ""} — update to v${info.minVersion} or later`;
    default:
      return info.message ?? "Status unknown";
  }
}

/** Actionable guidance for an agent error (§ UX empty & error states). */
export function errorGuidance(
  kind: ErrorKind,
  engine: EngineKind | null,
  message: string,
  minVersion?: string,
): string {
  const m = engine ? ENGINE_META[engine] : null;
  const label = m?.label ?? "The agent";
  switch (kind) {
    case "notInstalled":
      return `${label} isn't installed. Install it, then use Re-detect in Settings → AI.`;
    case "notLoggedIn":
      return `${label} isn't signed in. Run \`${m?.signIn ?? "login"}\` in a terminal, then try again.`;
    case "orgDisabled":
      return `${label} is disabled for your account by your organization. Ask your admin, or pick another engine.`;
    case "unsupportedVersion":
      return `This version of ${label} isn't supported. Update it${minVersion ? ` to v${minVersion} or later` : ""} and try again.`;
    case "quotaExceeded":
      return `You've reached your ${m?.plan ?? "plan's"} usage limit. Try again later or switch engines.`;
    case "crashed":
      return `${label} stopped unexpectedly. Retry to start a new session.`;
    case "protocol":
      return `${label} sent a response the app couldn't understand. Updating it usually fixes this.`;
    case "timeout":
      return `${label} didn't respond in time. Retry, or check your connection.`;
    default:
      return message || "Something went wrong.";
  }
}

const CANVAS_TOOL_LABELS: Record<string, string> = {
  list_tabs: "Listed tabs",
  get_scene_summary: "Read the canvas",
  get_selection: "Read the selection",
  get_elements: "Read elements",
  render_canvas_png: "Looked at the canvas",
  add_elements: "Added elements",
  update_elements: "Updated elements",
  delete_elements: "Deleted elements",
  connect: "Connected elements",
  add_mermaid: "Imported a Mermaid diagram",
  add_image: "Placed an image",
  arrange: "Arranged elements",
  set_viewport: "Moved the viewport",
  find_elements: "Searched the canvas",
  select_elements: "Selected elements",
  get_canvas_state: "Read the canvas settings",
  move_elements: "Moved elements",
  duplicate_elements: "Duplicated elements",
  set_canvas: "Changed the canvas settings",
  auto_layout: "Laid out the diagram",
  tidy_arrows: "Tidied arrows",
  apply_ops: "Edited the canvas",
  list_layers: "Read the layers",
  update_layer: "Updated a layer",
  set_shape_data: "Set shape data",
  set_arrow_anchors: "Pin arrow anchors",
  get_shape_data: "Read shape data",
  create_component: "Created a component",
  insert_instance: "Inserted a component instance",
  list_components: "Read the components",
  get_component_master: "Read a component design",
  edit_component_master: "Edited a component design",
  set_overrides: "Overrode instance values",
  reset_overrides: "Reset instance overrides",
  detach_instance: "Detached an instance",
  define_property: "Declared a component property",
  remove_property: "Removed a component property",
  set_properties: "Set instance properties",
  create_container: "Made a container",
  update_container: "Updated a container",
  remove_container: "Removed a container",
  add_to_container: "Added to a container",
  remove_from_container: "Took elements out of a container",
  list_containers: "Read the containers",
  list_styles: "Read the styles",
  create_style: "Created a style",
  apply_style: "Applied a style",
  update_style: "Updated a style",
  delete_style: "Deleted a style",
  reset_style_overrides: "Reset style overrides",
  list_my_components: "Read My components",
  insert_my_component: "Inserted from My components",
};

export function toolLabel(name: string, title: string | null): string {
  return title || CANVAS_TOOL_LABELS[name] || name;
}

/** Footer usage summary, e.g. "3 premium requests · 1,200 tokens". */
export function formatUsage(u: Usage): string | null {
  const parts: string[] = [];
  if (u.premiumRequests !== null)
    parts.push(`${u.premiumRequests} premium request${u.premiumRequests === 1 ? "" : "s"}`);
  const tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  if (u.inputTokens !== null || u.outputTokens !== null)
    parts.push(`${tokens.toLocaleString()} tokens`);
  return parts.length ? parts.join(" · ") : null;
}
