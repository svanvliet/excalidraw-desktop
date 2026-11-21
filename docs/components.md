# Components v1

Reusable components in the style of Sketch and Figma. A **master** lives on the canvas, and
**instances** are live copies of it. When you edit the master, every instance updates in the
same undo step. Each instance keeps its own position, scale and rotation, plus any per-slot
**overrides**.

Status: engine, wiring, agent tools and tests are done (FR-54, D-DX1…D-DX3, D-DX9). The
Components sidebar tab and the properties-panel UI are a follow-up lane. Until then,
**Alt/Option + Cmd/Ctrl + K** creates a component from the selection, and **Cmd/Ctrl + D**
(or copy/paste, or Alt-drag) on a master places an instance.

Code: `src/extensions/components/`, built on the reactor in `src/extensions/reactor/`. See
`docs/reactor-spike.md` for the reactor itself.

## 1. Data model

Every child of a component carries `customData["excalidrawDesktop.component"]` (D-DX2). It is
a sibling of the other `excalidrawDesktop.*` keys and is versioned (`v: 1`). This version
ignores a tag it can't read, such as one written by a newer version, and leaves the element
untouched.

| Field         | Meaning                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`        | `"master"` or `"instance"`                                                                                                                                                                  |
| `componentId` | Shared by the master and all its instances                                                                                                                                                  |
| `slot`        | Stable key of the master child this element mirrors: the master child's id when it joined. Instance children map 1:1 onto master slots.                                                     |
| `gi`          | Index in `groupIds` of the component group. **Identity = `groupIds[gi]`** (D-DX3): inner groups come before it and user groups around it come after it. Ungrouping a component detaches it. |
| `name`        | Optional display name                                                                                                                                                                       |
| `base`        | Instances only: the master child's centre, size and angle relative to the master origin at the last sync. Comparing it with the child's own geometry gives the instance transform.          |
| `overrides`   | Instances only: per-slot values that win over the master. The keys are `text`, `backgroundColor`, `strokeColor`, `opacity`, `link` and `fileId` (image).                                    |
| `promoted`    | Masters only: set when this master was an instance promoted after the master was deleted. It keeps the old overrides and base so the master can be demoted again (see §4).                  |

Element ids never change during sync, so arrows bound to instance children stay bound.

## 2. Sync

The reactor (D-DX1) watches `onChange` version diffs. Master children are its sources and
instance children are its targets, with `componentId` as the key. Each change runs
`syncComponent` for that component, which:

1. **Geometry**: derives each child from its master slot under the instance's inferred
   transform. The transform covers translation, uniform or non-uniform scale, and rotation of
   the whole instance. Linear elements scale their points too. Moving, resizing or rotating a
   whole instance changes only its inferred transform.
2. **Styles**: copies stroke, fill, roughness, font, roundness, arrowheads and so on from the
   master.
3. **Text**: copies the master's text unless the slot overrides it. Text is **re-measured**
   (`text.ts`, via the exported `convertToExcalidrawElements`), never copied, because overrides,
   scale and late-loading fonts all change the layout. Measurements are memoised per container.
4. **Children**: adds or removes children as the master changes. An element drawn or pasted
   into the master group (group editing) is adopted as a new master child. Every instance then
   gains a child for it, with a deterministic id, and loses the children of deleted slots. Undo
   restores deleted children rather than recreating them.
5. **Direct edits on an instance child**: an edit to an overridable key becomes an override
   ("adopt"). Any other edit, such as geometry inside the instance or roughness, is reverted to
   the master.

Sync patches are applied with `CaptureUpdateAction.NEVER`, in place (`apply: "mutate"`), and
are folded into the user's own undo entry. So **one undo reverts both the master edit and every
instance**, and redo replays both.

### In-place apply and the snapshot (reactor fix)

0.18.1's `updateScene` with `IMMEDIATELY` or `NEVER` runs `store.filterUncomittedElements`.
That keeps the store _snapshot_ copy of any element whose live object has a newer version. The
spike's mutate path mutated scene objects before `updateScene(NEVER)`, so the snapshot stayed
stale for every patched element. A later `IMMEDIATELY` commit on such an element, such as
_Reset overrides_, then vanished from history.

`reactor.ts` now works in this order:

1. Build clones with `newElementWith` and commit them with `NEVER` while the scene objects are
   untouched, so the snapshot advances.
2. Mutate the originals with `mutateElement` and copy the clone's `version`, `versionNonce` and
   `updated` onto them.
3. Hand the originals back with no capture flag. This creates no store action and keeps
   rough.js's `ShapeCache`.

There is a regression test in `components.real.test.tsx` ("an action on a sync-patched element
gets its own undo step").

### Mutate-safety audit

These are the places that keep element references:

- Autosave serialises the live scene lazily.
- The agent turn tracker (`turns.ts`) and `CollabSession` compare element **versions**, which
  `mutateElement` bumps, not object identity.
- `fontRefresh` caches by a `WeakMap` it only reads.

None of them hold a stale snapshot of an element that the in-place apply could invalidate.

## 3. Overrides, reset and detach

- **Set**: the agent's `set_overrides`, the UI's `setInstanceOverrides`, or editing an
  overridable key directly on an instance child. Each sets values per slot, and `null` clears
  one. Keys that don't apply to the element type (for example `text` on a rectangle) are
  rejected.
- **Reset** (`reset_overrides`): clears all overrides, or only those for some slots, element
  ids or keys. The instance follows the master again.
- **Detach** (`detach_instance`): removes the tags. The elements keep their group, position and
  current look, and stop following the master.

Each is one undo step. Undoing an adopted edit also clears the override it created.

## 4. Orphans: deleting the master

**Policy: promote.** When no live master is left, the instance with the smallest group id is
promoted to master. It keeps its current look, and the overrides it had are stored in
`promoted`. The other instances now follow it. The choice is deterministic, so peers converge
without coordinating.

If the original master comes back (undo of the delete, or a collab merge), the promoted master
is demoted back to an instance, with its old overrides and base restored. When several live
masters exist, the non-promoted one with the smallest group id wins.

We chose promote over detach-all because a deleted master shouldn't silently break every
instance, and undo restores the exact previous state.

## 5. Duplicate, paste and Alt-drag (`onDuplicate`)

`componentsOnDuplicate` runs inside Excalidraw's duplicate, paste and Alt-drag action, so its
result is part of that single undo step:

- A copy of a whole master (new group) becomes a new **instance**.
- **Alt-drag**: Excalidraw leaves the new ids behind and keeps dragging the originals. When
  every master copy sits exactly on its original, the roles swap. The stationary copies become
  the master and the dragged originals become the instance.
- A copy of an instance is another instance with the same overrides.
- A copy made inside a master group becomes a new master child. A copy made inside an instance
  group is detached.
- A pasted master whose component has no live master in this scene stays a master.

## 6. Collab

The editor's collab API is wrapped with `remoteApi(api)`, which uses the reactor's
`wrapRemoteApi`. Collab applies are therefore tagged **remote** and never re-derived: the
sending peer already synced its instances and broadcast them. Both host and guest editors run
the engine, so either peer's master edit reaches every instance exactly once, with no echo
(`components.collab.real.test.tsx`).

## 7. Lifecycle and API for UI

Use `host.ts`, re-exported from `index.ts`:

| Function / hook                                    | Use                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `installComponents(api)` / `uninstallComponents`   | Start or stop live sync for an editor. The editors call these on mount. |
| `reseedComponents(api)`                            | Re-index after a file is loaded into an existing editor                 |
| `remoteApi(api)`                                   | The API to hand to `CollabSession`                                      |
| `createComponentFromSelection(api, name?)`         | Create from the selection and select the new master                     |
| `insertComponentInstance(api, componentId, opts?)` | Place an instance (`x`, `y`, `scale`, `angle` in radians)               |
| `setInstanceOverrides` / `resetInstanceOverrides`  | Overrides                                                               |
| `detachComponentInstance(api, instance)`           | Detach                                                                  |
| `sceneComponents(api)`                             | `ComponentInfo[]` for a list or library view                            |
| `useComponentSelection(api)`                       | React hook: the component info for the current selection                |
| `handleComponentShortcut(api, e)`                  | Temporary Alt+Mod+K trigger (capture-phase keydown on the wrapper)      |

Every command goes through `runComponentCommand`. It builds a `Draft`, runs the action, syncs
inside the draft, and commits with `commitUndoable`, which seeds `{}` first so the first
`customData` write is undoable. The result is exactly one undo step.

Each tab mounts its own editor (`key = tab.id`), so switching tabs needs no reseed. The canvas
reseeds whenever `initialData` changes.

The shortcut isn't a registered Excalidraw action. Excalidraw cancels any shortcut that two
actions match, and its hyperlink action matches every Ctrl/Cmd+K, with or without Alt.

## 8. Agent tools

`create_component`, `insert_instance`, `list_components`, `set_overrides`,
`reset_overrides` and `detach_instance` are described in `docs/ai-integration.md`. All of the
edit tools work inside `apply_ops`.

`get_scene_summary` rows carry
`cmp: { id, role, slot, group, overrides? }`, and `get_elements` returns a `components` map.

Generic edits made through `update_elements`, `delete_elements` and similar tools re-sync the
components they touch within the same draft. They follow the same rules as UI edits: master
edits propagate, overridable instance edits become overrides, and other instance edits are
reverted.

## 9. Out of scope and caveats

- Nested components, component properties and styles (Wave 3). Nesting is rejected.
- The UI (sidebar tab, panel section and personal component library) is a follow-up lane.
- Bound text in rotated instances, and arrow labels, have only light test coverage.
- Alt-drag role swap is covered by a unit test of `componentsOnDuplicate`, not by a real
  browser drag.
- A component's elements must all share one frame, or none. Each instance keeps its own frame.
- Smart containers (`docs/containers.md`) work with components: a container inside a master is
  synced to instances like any other children (their copy of the box is inert), and an instance
  can be a container child. The container moves it as one unit without creating overrides.
