/**
 * Built-in desktop extensions (docs/extensions.md). Extensions are compiled into the app —
 * there is no plugin loading. Adding one: import it here, then run
 * `npm run extensions:sync-tools` so src/agent/tools.json advertises it to the agent.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { EXT_KEY, type AnyDesktopExtension, type ExtensionIntent } from "./types";

export const BUILTIN_EXTENSIONS: readonly AnyDesktopExtension[] = [];

let registry: readonly AnyDesktopExtension[] = BUILTIN_EXTENSIONS;

export function listExtensions(): readonly AnyDesktopExtension[] {
  return registry;
}

export function getExtension(id: string): AnyDesktopExtension | undefined {
  return registry.find((e) => e.id === id);
}

/** Test hook: swap the registry (pass nothing to restore the built-ins). */
export function setExtensionsForTests(list?: readonly AnyDesktopExtension[]): void {
  registry = list ?? BUILTIN_EXTENSIONS;
}

/** The raw intent stored on an element (not checked for staleness). */
export function storedIntent(el: ExcalidrawElement): ExtensionIntent | null {
  const raw = (el.customData as Record<string, unknown> | undefined)?.[EXT_KEY];
  if (!raw || typeof raw !== "object" || typeof (raw as ExtensionIntent).ext !== "string") {
    return null;
  }
  return raw as ExtensionIntent;
}

export interface ElementExtensionState {
  /** Applied extensions → their params. */
  applied: Record<string, Record<string, unknown>>;
  /** Extension ids whose stored intent no longer matches the element (edited elsewhere). */
  stale: string[];
}

/** What extensions are applied to an element, for the UI and the agent's read tools. */
export function extensionStateOf(el: ExcalidrawElement): ElementExtensionState | null {
  const applied: Record<string, Record<string, unknown>> = {};
  for (const ext of registry) {
    if (!ext.appliesTo(el)) continue;
    const intent = ext.getIntent(el);
    if (intent) applied[ext.id] = intent.params;
  }
  const stored = storedIntent(el);
  const stale = stored && !applied[stored.ext] ? [stored.ext] : [];
  if (!Object.keys(applied).length && !stale.length) return null;
  return { applied, stale };
}
