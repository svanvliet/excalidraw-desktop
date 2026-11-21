/**
 * Commit agent drafts to a canvas and group them into undoable "turns" (D-AI3).
 *
 * ## How Excalidraw 0.18.1 history works (read from dist/dev/index.js `updateScene` and
 * chunk-4FTI6OG3.js `Store`)
 *
 * The undo stack is fed by `Store.captureIncrement(next)`: it diffs `next` against the store's
 * *snapshot* (the last committed state) and pushes that delta as one undo entry, then makes
 * `next` the new snapshot. `api.updateScene({elements, captureUpdate})` always replaces the
 * scene elements, and in addition:
 *  - `IMMEDIATELY` → `captureIncrement` (one undo step for snapshot → next).
 *  - `NEVER`       → `updateSnapshot` (snapshot := next, no undo step; the change is invisible
 *                    to history — undo will never revert it).
 *  - `EVENTUALLY`  → store untouched; the change is folded into whatever the *next* IMMEDIATELY
 *                    capture is (including an unrelated user action). Unsafe for us.
 * Before either store call, `filterUncomittedElements` swaps any element the scene has at a
 * newer version than the snapshot back to its snapshot version (so uncommitted in-progress user
 * edits don't leak into the diff); elements removed from the array become tombstones in the
 * snapshot (`createElementsSnapshot`).
 *
 * ## One undo step per agent turn
 * Inside a turn every tool commit uses `NEVER`, so the snapshot tracks the agent's live edits
 * and any user action mid-turn captures only the user's own change. At `endTurn` we issue two
 * synchronous `updateScene` calls inside one React batch (collaborators only see the final
 * state through `onChange`):
 *   1. `NEVER` with every element the turn touched reset to its pre-turn baseline (elements the
 *      turn added are left out → snapshot tombstones) — rewinds the snapshot to "before turn".
 *   2. `IMMEDIATELY` with the final elements — captures the whole turn as one increment.
 * Edits outside a turn commit with `IMMEDIATELY` (one undo step per tool call).
 *
 * ## Fields that were `undefined`
 * Undo/redo applies deltas through `newElementWith`, which skips `undefined` values — so undoing
 * the first write of a field the element lacked (e.g. `customData`, or `fixedSegments` on an
 * arrow converted to elbow) silently keeps the new value. `commitUndoable`, `commitRerouted` and
 * `endTurn` therefore seed an empty value (`{}` for customData, else null) into the snapshot
 * first (NEVER), so the recorded delta is empty → new and undo restores the empty value.
 *
 * `revertTurn` is separate from undo: it writes the baseline back as *new versions* (so collab
 * peers accept it) and is itself one undoable step.
 */
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { isElbowArrow, routedElbow } from "../../lib/elbowAnchors";
import { log } from "../../lib/logger";
import { getSceneTab, type SceneTab } from "../sceneBridge";
import type { Draft, El } from "./draft";

interface TurnState {
  turnId: string;
  active: boolean;
  /** Pre-turn copy of each touched element; null = the turn created it. */
  baseline: Map<string, El | null>;
  /** Version we last wrote for each touched element (detects later edits by others). */
  lastWritten: Map<string, number>;
}

const MAX_TURNS_PER_TAB = 50;
const turnsByTab = new Map<string, Map<string, TurnState>>();
const activeTurnByTab = new Map<string, string>();

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function activeTurn(tabId: string): TurnState | undefined {
  const id = activeTurnByTab.get(tabId);
  return id ? turnsByTab.get(tabId)?.get(id) : undefined;
}

function recordWritten(turn: TurnState, api: SceneTab["api"], ids: Iterable<string>): void {
  const byId = new Map(api.getSceneElementsIncludingDeleted().map((e) => [e.id, e]));
  for (const id of ids) {
    const el = byId.get(id);
    if (el) turn.lastWritten.set(id, el.version);
    else turn.lastWritten.delete(id);
  }
}

/**
 * Fields `after` sets that `before` lacks (undefined), with the empty value undo should restore:
 * `{}` for customData, null otherwise (e.g. an arrow converted to elbow gains fixedSegments).
 */
function seedOf(before: El | undefined, after: El | undefined): Record<string, unknown> | null {
  if (!before || !after) return null;
  const b = before as unknown as Record<string, unknown>;
  let seed: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(after)) {
    if (v === undefined || b[k] !== undefined) continue;
    (seed ??= {})[k] = k === "customData" ? {} : null;
  }
  return seed;
}

/**
 * Commit a draft as exactly one undo step that undo can fully revert (see "Fields that were
 * undefined" above). Used by agent tools outside a turn and by UI panels (e.g. Layers).
 */
export function commitUndoable(api: SceneTab["api"], draft: Draft): void {
  const seeds = new Map<string, Record<string, unknown>>();
  for (const id of draft.changed) {
    const seed = seedOf(draft.original.get(id), draft.peek(id));
    if (seed) seeds.set(id, seed);
  }
  let elements = draft.toArray();
  if (seeds.size) {
    const scene = api.getSceneElementsIncludingDeleted() as readonly El[];
    api.updateScene({
      elements: scene.map((el) => {
        const seed = seeds.get(el.id) && seedOf(el, { ...el, ...seeds.get(el.id) } as El);
        return seed ? newElementWith(el, seed as never) : el;
      }),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    // The seed bumped those versions; bump ours past it so the final write wins everywhere.
    elements = elements.map((el) => (seeds.has(el.id) ? newElementWith(el, {}, true) : el));
  }
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

/** Write a draft to the canvas (one undo step, or folded into the active turn). */
export function commitDraft(
  tabId: string,
  tab: SceneTab,
  draft: Draft,
  files?: BinaryFileData[],
): void {
  if (!draft.changed.size && !files?.length) return;
  const turn = activeTurn(tabId);
  const touched = new Set([...draft.changed, ...draft.reroute]);
  if (turn) {
    for (const id of touched) {
      if (turn.baseline.has(id)) continue;
      const orig = draft.original.get(id);
      turn.baseline.set(id, orig ? clone(orig) : null);
    }
  }
  if (files?.length) tab.api.addFiles(files);
  if (turn) {
    if (draft.reroute.size) commitRerouted(tab.api, draft, CaptureUpdateAction.NEVER);
    else
      tab.api.updateScene({ elements: draft.toArray(), captureUpdate: CaptureUpdateAction.NEVER });
    recordWritten(turn, tab.api, touched);
  } else if (draft.reroute.size) {
    commitRerouted(tab.api, draft, CaptureUpdateAction.IMMEDIATELY);
  } else {
    commitUndoable(tab.api, draft);
  }
  tab.markDirty();
}

/**
 * Excalidraw only routes elbow arrows that are live in its Scene, so: write the draft without
 * history, let Excalidraw route the flagged arrows, then (outside a turn) rewind the snapshot to
 * the pre-draft state as endTurn does, so the routed result lands as a single undo step.
 */
/** Commit a draft as one undo step outside any agent turn, routing its flagged elbow arrows. */
export function commitDraftUndoable(api: SceneTab["api"], draft: Draft): void {
  if (draft.reroute.size) commitRerouted(api, draft, CaptureUpdateAction.IMMEDIATELY);
  else commitUndoable(api, draft);
}

function commitRerouted(
  api: SceneTab["api"],
  draft: Draft,
  capture: (typeof CaptureUpdateAction)[keyof typeof CaptureUpdateAction],
): void {
  api.updateScene({ elements: draft.toArray(), captureUpdate: CaptureUpdateAction.NEVER });
  const live = api.getSceneElementsIncludingDeleted();
  const routed = live.map((el) => {
    if (!draft.reroute.has(el.id) || el.isDeleted || !isElbowArrow(el)) return el;
    try {
      return routedElbow(el);
    } catch (err) {
      log.warn(`agent: elbow re-route of ${el.id} failed`, err);
      return el;
    }
  });
  if (capture === CaptureUpdateAction.IMMEDIATELY) {
    const rewound: El[] = [];
    for (const el of live) {
      if (!draft.changed.has(el.id)) rewound.push(el);
      else {
        const orig = draft.original.get(el.id);
        const seed = seedOf(orig, el);
        if (orig) rewound.push(seed ? ({ ...orig, ...seed } as El) : orig);
      }
    }
    api.updateScene({ elements: rewound, captureUpdate: CaptureUpdateAction.NEVER });
  }
  api.updateScene({ elements: routed, captureUpdate: capture });
}

/** Start grouping this tab's agent edits under `turnId`. Ends any other active turn first. */
export function beginTurn(tabId: string, turnId: string): void {
  const prev = activeTurnByTab.get(tabId);
  if (prev && prev !== turnId) endTurn(tabId, prev);
  let turns = turnsByTab.get(tabId);
  if (!turns) turnsByTab.set(tabId, (turns = new Map()));
  if (!turns.has(turnId)) {
    turns.set(turnId, { turnId, active: true, baseline: new Map(), lastWritten: new Map() });
    while (turns.size > MAX_TURNS_PER_TAB) turns.delete(turns.keys().next().value!);
  }
  turns.get(turnId)!.active = true;
  activeTurnByTab.set(tabId, turnId);
}

/** Close the turn and collapse its edits into a single undo step. Returns #elements touched. */
export function endTurn(tabId: string, turnId: string): number {
  const turn = turnsByTab.get(tabId)?.get(turnId);
  if (!turn || !turn.active) return 0;
  turn.active = false;
  if (activeTurnByTab.get(tabId) === turnId) activeTurnByTab.delete(tabId);
  const tab = getSceneTab(tabId);
  if (!tab || !turn.baseline.size) return turn.baseline.size;

  const current = tab.api.getSceneElementsIncludingDeleted();
  const rewound: El[] = [];
  for (const el of current) {
    if (!turn.baseline.has(el.id)) {
      rewound.push(el);
      continue;
    }
    // Someone else changed it after our last write: keep theirs so we don't undo their edit.
    if (turn.lastWritten.get(el.id) !== el.version) {
      rewound.push(el);
      continue;
    }
    const base = turn.baseline.get(el.id);
    if (base) {
      rewound.push({ ...clone(base), ...seedOf(base, el) });
    }
    // base === null → added by this turn → omitted (snapshot tombstone).
  }
  try {
    tab.api.updateScene({ elements: rewound, captureUpdate: CaptureUpdateAction.NEVER });
    tab.api.updateScene({ elements: current, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  } catch (err) {
    log.error(`agent: endTurn ${turnId} failed to collapse undo history`, err);
    tab.api.updateScene({ elements: current, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  recordWritten(turn, tab.api, turn.baseline.keys());
  return turn.baseline.size;
}

export type RevertTurnResult =
  | { ok: true; reverted: number }
  | { ok: false; reason: "unknown" | "empty" }
  | { ok: false; reason: "conflict"; ids: string[] };

/** True when the turn exists and changed something (UI shows the "Revert turn" action). */
export function canRevertTurn(tabId: string, turnId: string): boolean {
  return (turnsByTab.get(tabId)?.get(turnId)?.baseline.size ?? 0) > 0;
}

/**
 * Restore every element this turn touched to its pre-turn state (turn-added elements are
 * deleted). Elements edited by someone else after the agent are a conflict unless `force`.
 */
export function revertTurn(
  tabId: string,
  turnId: string,
  opts: { force?: boolean } = {},
): RevertTurnResult {
  const turn = turnsByTab.get(tabId)?.get(turnId);
  const tab = getSceneTab(tabId);
  if (!turn || !tab) return { ok: false, reason: "unknown" };
  if (turn.active) endTurn(tabId, turnId);
  if (!turn.baseline.size) return { ok: false, reason: "empty" };

  const current = tab.api.getSceneElementsIncludingDeleted();
  const byId = new Map(current.map((e) => [e.id, e]));
  const conflicts = [...turn.baseline.keys()].filter((id) => {
    const el = byId.get(id);
    return el !== undefined && turn.lastWritten.get(id) !== el.version;
  });
  if (conflicts.length && !opts.force) return { ok: false, reason: "conflict", ids: conflicts };

  let reverted = 0;
  const next = current.map((el) => {
    if (!turn.baseline.has(el.id)) return el;
    const base = turn.baseline.get(el.id);
    reverted++;
    if (!base) return newElementWith(el, { isDeleted: true }, true);
    const fields: Record<string, unknown> = { ...base };
    for (const k of ["id", "version", "versionNonce", "updated", "index"]) delete fields[k];
    return newElementWith(el, fields as never, true);
  });
  tab.api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  tab.markDirty();
  turnsByTab.get(tabId)!.delete(turnId);
  return { ok: true, reverted };
}

/** Drop all turn bookkeeping for a tab (tab closed) — or everything, for tests. */
export function resetTurns(tabId?: string): void {
  if (tabId === undefined) {
    turnsByTab.clear();
    activeTurnByTab.clear();
  } else {
    turnsByTab.delete(tabId);
    activeTurnByTab.delete(tabId);
  }
}
