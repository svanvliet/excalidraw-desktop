/**
 * Built-in desktop extensions (docs/extensions.md). Extensions are compiled into the app —
 * there is no plugin loading. Adding one: import it here, then run
 * `npm run extensions:sync-tools` so src/agent/tools.json advertises it to the agent.
 */
import { borderExtension } from "./border";
import { maskExtension } from "./mask";
import type { AnyDesktopExtension } from "./types";

export const BUILTIN_EXTENSIONS: readonly AnyDesktopExtension[] = [maskExtension, borderExtension];

const byStage = (list: readonly AnyDesktopExtension[]) =>
  [...list].sort((a, b) => a.stage - b.stage);

let registry: readonly AnyDesktopExtension[] = byStage(BUILTIN_EXTENSIONS);

/** Registered extensions, in chain (stage) order. */
export function listExtensions(): readonly AnyDesktopExtension[] {
  return registry;
}

export function getExtension(id: string): AnyDesktopExtension | undefined {
  return registry.find((e) => e.id === id);
}

/** Test hook: swap the registry (pass nothing to restore the built-ins). */
export function setExtensionsForTests(list?: readonly AnyDesktopExtension[]): void {
  registry = byStage(list ?? BUILTIN_EXTENSIONS);
}
