# Reactor spike: derived sync on Excalidraw 0.18.1

> **Status: experimental spike (Wave 1, `dx-spikes`).** It de-risks D-DX1 (derived-sync engine) and
> D-DX3 (instance identity) for Wave 2 (Components) and Wave 3 (styles, smart containers). The
> prototype is **not wired into the app**. Nothing here ships to users.

- Code: `src/extensions/reactor/` (`reactor.ts`, `mirrorRule.ts`, `arrows.ts`, `textLayout.ts`,
  `duplicate.ts`) and the perf harness page `src/extensions/reactor/spike/`.
- Tests that encode every finding:
  - `src/extensions/reactor/reactor.real.test.tsx`: the real `<Excalidraw>` in jsdom, covering points 1, 4 and 5, the loop guard and no-op writes.
  - `src/extensions/reactor/reactor.collab.real.test.tsx`: two real `<Excalidraw>` peers plus the real `CollabSession` over `MemoryRelay`, covering point 3.
  - `e2e/spikes/reactor.spike.ts`: headless Chromium with a real mouse drag on 1,000 elements, covering points 2 and 4. Run it with `npm run e2e:reactor-spike`. It uses its own config, `playwright.spike.config.ts`, so `npm run e2e` never runs it.
- To run every Vitest finding against the alternative apply mode, use
  `REACTOR_APPLY=mutate npx vitest run src/extensions/reactor`. All 13 tests pass in both modes.

## Verdict

| #   | Question                                                    | Verdict                        | One-line evidence                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One undo/redo restores source + targets, no history fights  | **GO**                         | Undo restores the source; the reactor re-derives the targets on the next frame. The NEVER apply adds no entries and doesn't clear redo. Verified with buttons and with Cmd/Ctrl+Z after a real drag.                 |
| 2   | Live drag of a source on ~1,000 elements                    | **GO**, with `apply: "mutate"` | 990 derived targets: frame p95 is 9.8 to 16.6 ms, the same as the no-reactor baseline. The flush itself takes 3 to 5 ms. With `replace` the p95 is 100 to 125 ms, which is janky.                                    |
| 3   | Collab: only the editing peer propagates; converge, no echo | **GO**                         | Wrapping the API passed to `CollabSession` is the only integration. The receiving peer derives 0 elements and sends 0 `SCENE_UPDATE`s. Both peers end with identical versions, and traffic goes quiet.               |
| 4   | Overridden text re-measures without unexported helpers      | **GO**                         | `convertToExcalidrawElements` with a labelled container skeleton wraps and centres exactly like a native label. In Chromium it uses the real loaded font.                                                            |
| 5   | Duplicate/paste → instance; arrow bindings survive          | **GO**, with one caveat        | `onDuplicate` turns Ctrl+D or paste copies into instances in the same undo step. Arrows bound to derived children keep their binding, follow the target, and undo correctly. Alt-drag swaps roles (see Limitations). |

## How the prototype works

```
user edit / undo / redo / remote apply
        │  api.onChange(elements)
        ▼
observe: stamp = `${version}:${versionNonce}` per element
  ├─ stamp === expected[id]  → ours or a tagged remote apply → ignore (and forget)
  ├─ changed source          → dirtyKeys += link.key
  └─ changed target          → dirtyTargets += id   (direct edits / undo get re-derived)
        │  requestAnimationFrame throttle (one flush per frame, however many changes)
        ▼
flush: passes ≤ maxPasses (default 4)
  ├─ work = targets of dirty keys + dirty targets; containers before their bound text
  ├─ rule.derive(target, source, ctx) → patch → effectivePatch (drop no-op keys)
  ├─ a patched container queues its bound text (re-layout); chained sources → next pass
  ├─ loop guard: an element already rewritten in this flush is never rewritten again
  └─ followBoundArrows: move bound arrow ends with their targets
        ▼
apply: expected[id] = new stamp; api.updateScene({ elements, captureUpdate: NEVER })
```

- **The local-origin test is a version diff, nothing else.** History and the store need no
  hooks. Undo and redo apply through `NEVER` and are seen as ordinary local changes to the source,
  so the targets re-derive.
- **Remote tagging.** `reactor.wrapRemoteApi(api)` returns a Proxy whose `updateScene` stamps
  every incoming element whose object identity differs from the current scene element as
  `expected`. Passing it as `CollabSession`'s `api` is the entire collab integration. No collab code changed.
- **Rule shape.** A `ReactorRule` has `links(el)` (role and key per element, read from `customData`)
  and `derive(target, source, ctx)`, which returns a patch or `null`. The spike rule, `mirrorRule`, derives:
  - geometry, as source plus an offset;
  - style keys;
  - text, with an optional override that is re-measured in the target's container.

  Links live in `customData["excalidrawDesktop.reactorSpike"]`, so they're throwaway, spike-only data.

- **Apply modes.**
  - `replace` (the default) builds new objects with `newElementWith`.
  - `mutate` patches the scene's own objects with the exported `mutateElement` (with
    `informMutation=false`), then calls `updateScene(NEVER)` with the same array.

## Findings per point

### Point 1: undo/redo (GO)

- One captured user edit makes exactly one history entry. The reactor's `NEVER` writes create no entries
  (the Undo button stays disabled afterwards) and **do not clear the redo stack**.
- Undo and redo restore only what the entry recorded, which is the source. The targets then re-derive on the next
  frame, so there is a single-frame lag. Stamps match afterwards, so there's no drift and no second pass.
- Derived writes **never ride along in the user's next entry**. In both modes, undoing a later edit
  doesn't revert an earlier derivation.
- A direct edit to a target is reverted by re-derivation (no drift). Real Components will need an
  explicit override UX instead (see the design below).
- Upstream quirks that the design must respect:
  - **Arrow-key nudges are `EVENTUALLY` in 0.18.1.** They create no entry until the next
    `IMMEDIATELY` action, which absorbs them. The targets still follow live. Undo of the combined entry
    restores the source, and the targets re-derive.
  - **The `updateScene` filter.** With `IMMEDIATELY` or `NEVER`, `store.filterUncomittedElements` keeps
    the _snapshot_ version of any element that has an uncommitted local edit (a nudge, or a drag in progress).
    So an API write can't commit a pending user edit on that element. That's why mid-drag reactor writes
    never absorb the dragged source into the snapshot. The edge case: a _target_ that itself has an
    uncommitted local edit gets its derived change captured into the user's next entry. The effect is harmless,
    because undo re-derives, but it isn't "pure".
- Real browser: after a 90-step mouse drag of a master, one `Cmd/Ctrl+Z` restores the source and all
  990 targets, and `Cmd/Ctrl+Shift+Z` redoes it.

### Point 2: drag performance (GO with `apply: "mutate"`)

Headless Chromium on the dev Mac, at 120 Hz, so 8.3 ms is one frame. The test drags a master group (10 elements, 5 labelled
rects) with a real mouse, one step per frame for 90 steps. Results from two runs on a shared machine, so there's some noise:

| Scenario (1,000 elements)               | Frame p50 | Frame p95          | Flush p50 / p95      | Drag wall time |
| --------------------------------------- | --------- | ------------------ | -------------------- | -------------- |
| Baseline (no reactor), 99 instances     | 8.3 ms    | 9.8 to 9.9 ms      | n/a                  | 1.6 s          |
| `replace`, 99 instances (990 targets)   | 8.4 ms    | **100 to 125 ms**  | 3.0–3.8 / 4.1–4.8 ms | 9.9 to 12.3 s  |
| `mutate`, 99 instances (990 targets)    | 8.3 ms    | **9.8 to 16.6 ms** | 2.6–3.6 / 3.1–5.0 ms | 2.6 to 3.1 s   |
| Baseline, 9 instances + 900 plain rects | 8.3 ms    | 9.2 to 9.6 ms      | n/a                  | 1.6 s          |
| `replace`, 9 instances (90 targets)     | 8.3 ms    | 9.7 to 16.8 ms     | 0.9–1.2 / 1.1–1.6 ms | 2.7 to 3.6 s   |
| `mutate`, 9 instances (90 targets)      | 8.3 ms    | 9.7 to 9.9 ms      | 0.8–0.9 / 1.1–1.4 ms | 2.1 to 2.5 s   |

- **The reactor's own cost is small.** Observing, deriving and building patches for 990 targets takes about 3 to 5 ms per frame.
- **The jank in `replace` mode is Excalidraw's renderer, not the reactor.** `ShapeCache` is a `WeakMap`
  keyed by element object, so every new object from `newElementWith` regenerates its rough.js
  shape on the next render. `mutateElement` keeps the object, and it only evicts the cache when
  `width`, `height`, `points` or `fileId` change, so position-only derivation reuses the shapes. This is
  the same path Excalidraw's own drag uses.
- Drag wall time is still about 1.6 to 2× baseline, because each reactor write triggers one extra render per step.
  The frames stay within budget.
- `mutate` is verified against every Vitest finding (undo, redo, nudge, collab, duplicate, arrows,
  text) and the real-browser undo/redo. The new test proves that derived writes don't leak into the next entry.

### Point 3: collab (GO)

The test uses two real Excalidraw peers and real `CollabSession`s over `MemoryRelay`, with the scene changes wired from
`onChange` to `onSceneChange`:

- **Tagged (recommended):** only the editing peer derives. The receiver's `stats.patched` stays 0, and it sends
  **0 `SCENE_UPDATE`s**. The editor sends 1 or 2: the source, then the derived targets. Both peers end
  with identical `version:versionNonce` for every element. Edits from the other peer propagate the other
  way symmetrically. After quiescence there's no traffic at all, so there's no echo loop.
- Joining (`SCENE_INIT`) isn't mistaken for a local edit.
- **Untagged (worst case):** the receiving peer treats the remote source change as local and
  re-derives it. Because patches are idempotent and reconcile is version-based, the peers still converge
  and go quiet. The cost is duplicate writes and, depending on timing, competing equal-valued versions
  on the wire. That's why tagging matters, but a missed tag isn't catastrophic.

### Point 4: overridden text (GO)

- Excalidraw's `wrapText` and `redrawTextBoundingBox` are not exported. Instead, `measureBoundText` builds a
  one-off labelled-container skeleton with the exported `convertToExcalidrawElements` (same
  container type, size and angle; the text's font, size, alignment and line height) and copies the resulting text
  geometry (x, y, width, height, text, originalText) onto the existing text id.
- jsdom: the wrapped, centred result equals a native skeleton label of the same container.
- Chromium: the re-measured width equals `measureText` with the **loaded Excalifont** (53.79 px for "Item 0" at 16 px).
  A long override wraps within the 90 px container and stays centred.
- **Finding:** text built by a skeleton _before_ the font loads keeps a stale fallback-font width.
  The harness master stored 41.32 px, the Virgil metric, and Excalidraw never refreshed it. So
  **re-measure derived text instead of copying `width` from the source** whenever fonts or text could differ.
- A target container's bound text doesn't follow a container moved by `updateScene`. The reactor
  re-derives the bound text of every patched container in the same flush, with containers sorted first.
- Not handled: growing the container when the override doesn't fit. `measureBoundText` returns
  `containerHeight` (native labels grow), but the spike doesn't apply it.

### Point 5: duplicate → instance, arrow bindings (GO, with caveat)

- **`onDuplicate(next, prev)`** (0.18.1 prop) runs inside Excalidraw's own duplicate, paste and
  Alt-drag actions. Returning modified elements lands them **in the same single undo step**.
  `mirrorOnDuplicate` turns new-id copies of a source into targets, with the offset measured from the source in `prev`.
  One undo removes the copy entirely.
- An orphan copy, whose source isn't in `prev` (for example a paste into another file), stays a source.
- **Arrows:** `updateScene` doesn't re-route arrows bound to a moved or resized target, so
  `followBoundArrows` maps each bound end through the old → new box:
  - points inside the box scale with it;
  - points outside keep their distance from the nearest edge, which preserves the binding gap.

  `startBinding` and `endBinding` are untouched, because element ids never change on sync (D-DX3). The binding
  survives, the end follows, and undo restores the arrow.

- **Alt-drag caveat:** Excalidraw gives the _stationary_ copy the new ids and keeps dragging the
  original. So the stationary copy becomes the instance at offset 0, follows the dragged master, and the two
  overlap. Components v1 must detect this. One option: in `onDuplicate`, swap roles when the copy's position
  equals the source's and a drag is in progress.

## APIs used (all exported by 0.18.1)

| API                                         | Use                                                               |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `api.onChange`                              | Observe every scene change (local, undo/redo, remote)             |
| `api.updateScene({ captureUpdate: NEVER })` | Apply derived patches without history entries                     |
| `api.getSceneElementsIncludingDeleted`      | Read the scene at flush time                                      |
| `CaptureUpdateAction`                       | `NEVER` for reactor writes; `IMMEDIATELY` in tests for user edits |
| `newElementWith`                            | `replace` mode, and building patched arrows                       |
| `mutateElement`                             | `mutate` mode: in-place patch that keeps `ShapeCache`             |
| `convertToExcalidrawElements`               | Text re-measure via a labelled-container skeleton                 |
| `<Excalidraw onDuplicate>`                  | Copy → instance inside the duplicate/paste undo step              |
| `CollabSession({ api })` (ours)             | Pass `reactor.wrapRemoteApi(api)` to tag remote applies           |

No unexported helpers or deep imports are used, and nothing is patched or forked.

## Limitations (prototype)

- **Elbow arrows** bound to a target are only translated, and only when every end moves by the same delta. Excalidraw's
  elbow routing (`updateElbowArrowPoints`) isn't exported. In `mutate` mode, `mutateElement` re-routes
  elbow arrows itself when `points` or bindings are passed; that's untested here.
- **Rotation:** angle is copied, but arrow-end mapping and offsets assume unrotated boxes.
- **Targets with uncommitted local edits** get their derived change captured into the user's next entry
  (see Point 1). This is harmless.
- **Single-frame lag** after undo/redo before the targets re-derive. It's visible only at slow-motion speeds.
- **`reseed()` is required** after any wholesale scene replacement (file open, `SCENE_INIT`). Otherwise
  the first observe diffs against the old scene. The collab test shows that `SCENE_INIT` itself is fine
  because the elements arrive tagged.
- **Container growth** for overridden text is ignored (see Point 4).
- **Direct target edits are reverted.** That's correct for the spike, but users need a way to
  override or detach.
- **`mutate` mode** mutates scene-owned objects. Any app code that caches element _references_ and
  compares by identity would miss these changes. `CollabSession` (version-based) is fine, as the collab test
  shows in both modes. Wave 2 should audit autosave and dirty tracking. Text needs re-measure anyway,
  so `width`/`height` changes evict the shape cache correctly.
- **Untagged remote applies** cause duplicate writes (Point 3).
- **Alt-drag role swap** (Point 5).

## Recommended design for Components v1

1. **One reactor per editor**, created next to the `excalidrawAPI`, with `apply: "mutate"` and an rAF
   schedule. Pass `reactor.wrapRemoteApi(api)` to `CollabSession`, and call `reactor.reseed()` on file open,
   new file and `SCENE_INIT`. Use one shared engine with pluggable rules (`component`, later `style` and
   `layout`), keyed by link keys. That matches D-DX1.
2. **Storage (D-DX2/D-DX3).**
   - The master is the source. Each master child gets a stable `slot` key in
     `customData.excalidrawDesktop.component = { role: "master" | "instance", componentId, slot, overrides? }`.
   - Instance identity is the instance's **outer groupId**. Instance-child offsets are derived from the
     instance group's bounding box relative to the master's, rather than stored per child. This makes moving an instance
     free, so it needs no reactor write.
3. **Derive geometry relatively.** Moving an _instance_ must not be a reactor event. Only master changes
   (shape, size, style, text, added or removed children) propagate. Instance-local placement is user data.
4. **Overrides** are explicit per-slot keys (`text`, `backgroundColor`, …). Overridden text is always
   re-measured with `measureBoundText`, and the container grows if needed. Never copy text `width`
   from the master; re-measure (Point 4 font finding). A direct edit of an overridable key on an
   instance child should _become_ an override, by detecting a target change whose key isn't derived,
   instead of being reverted. A "Reset overrides" action clears them.
5. **Duplicate, paste and library insert** go through `onDuplicate`. Copies of a master become instances;
   copies of an instance stay instances of the same master. Special-case Alt-drag: the copy that sits at
   the source's exact position during a drag is the original. Paste into another file → orphan → offer
   "Detach" or "Make master".
6. **Structural edits** (adding or removing a master child) create or delete the matching child in each
   instance. Do this through the same flush (NEVER), with new ids generated deterministically from
   `(instanceGroupId, slot)` so peers converge without duplicates.
7. **Arrows:** keep `followBoundArrows` for straight and curved arrows. For elbow arrows, rely on
   `mutateElement` re-routing (exported) and add a test, or limit v1 to straight arrows bound to
   instance children.
8. **Tests to carry forward:** the 13 real-Excalidraw Vitest findings, the collab pair test, and the
   headless drag perf check (p95 frame ≤ 33 ms on 1,000 elements) as a non-CI spike suite.
