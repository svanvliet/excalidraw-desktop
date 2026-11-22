# Components v1

Reusable components in the style of Sketch and Figma. A **master** defines the component, and
**instances** are live copies of it. When you edit the master, every instance updates in the
same undo step. Each instance keeps its own position, scale and rotation, plus any per-slot
**overrides**. The master lives off-canvas (FR-64, §4a): creating a component turns the
selection into its first instance, and the master only appears while it is being edited.

Status: engine, wiring, agent tools and tests are done (FR-54, D-DX1…D-DX3, D-DX9), with the
Components UI (FR-55, §7a), properties (FR-56, §4b) and nested components (FR-57, §4c).
**Alt/Option + Cmd/Ctrl + K** creates a component from the selection, and **Cmd/Ctrl + D**
(or copy/paste, or Alt-drag) on an instance places another one.

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
| `overrides`   | Instances only: per-slot values that win over the master. Keys: `text`, `backgroundColor`, `strokeColor`, `opacity`, `link`, `fileId` (image) and `visible` (hides the slot).               |
| `promoted`    | Masters only: set when this master was an instance promoted after the master was deleted. It keeps the old overrides and base so the master can be demoted again (see §4).                  |
| `source`      | Optional, `"library"`: the master lives in the app's library and is usually off-canvas. Library orphans are never promoted (§4a). Older readers ignore it.                                  |
| `libraryId`   | Optional: the library key of the master (the `componentId`, since "My components" is keyed by it)                                                                                           |
| `mv`          | Instances of library components only: the master's overridable values at the last sync. They let edits become overrides, and let the master be rebuilt, while it's off-canvas.              |
| `props`       | Typed component properties (§4b), replicated on the master's and instances' children                                                                                                        |
| `pv`          | Instances only, replicated on the instance's children: property values by property id. Absent = the property's default.                                                                     |
| `npv`         | Instances only: property values of the component instances nested directly in the master, keyed by the nested instance's group id there (§4c)                                               |

An element that belongs to several components at once (a child of an A instance inside B's
master or B's instances, §4c) holds `{ v: 2, tags: [...] }`: one tag per component, inner to
outer by `gi`. A single tag is still written as `v: 1` unless it uses a v2 field (`props`, `pv`,
`npv`, `visible`), so drawings without the new features stay readable by older builds, which leave
v2 data alone.

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
   scale and late-loading fonts all change the layout. Measurements are memoised per container,
   but only once the font is loaded (`fontReady`): a sync that runs earlier (for example the
   load-time demotion) would otherwise keep fallback-font widths and clip property values.
   `watchComponentFonts` re-measures every instance text when fonts finish loading
   (`relayoutComponentText`, not an undo step). Left-aligned text keeps its x, centred text its
   centre. Fixed-width text (`autoResize: false`) keeps its width, wraps, and grows its height
   (FR-56).
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

## 4a. Library-backed (off-canvas) masters

This is the default model (FR-64, D-DX18). `createComponentFromSelection` creates the component
and immediately demotes its master (`demoteMaster`), so the selection becomes the first
instance. Drawings saved with on-canvas masters are demoted when they open (`demoteMastersIn`
in the editor's `initialData`, `demoteLegacyMasters(api)` for a loaded editor). A demoted
instance keeps its slots, so nested copies and property bindings still resolve. It is derived
once against its own master as it is demoted, so it looks like a freshly inserted instance with
no values set: choice and boolean defaults apply (an "Avatar: photo" default hides the initials
slot), and text properties without a default keep the master's text.

A master can live in the library instead of on the canvas. Its tag then carries
`source: "library"` and `libraryId`. When such a component has no live master, its instances
**stay instances**: no promotion. They are self-contained copies, keeping their base geometry,
overrides and recorded master values (`mv`). Direct edits to them still become overrides
against `mv`. The check looks at every member tag, deleted ones included, so the UI's
insert-from-library draft (place master → insert instance → delete master → tag
`source`/`libraryId`) never promotes, as long as no sync runs between the delete and the tag.

Helpers in `host.ts` each run as one undo step through `runComponentCommand`. They return
`null` in view mode or on error, and the reason is shown as a toast.

| Function                                      | Does                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dematerializeMaster(api, masterGroupId)`     | Tags every element of the component (`source:"library"`, `libraryId` = existing or `componentId`), syncs so instances record `mv`, then removes the master (and unbinds arrows from it). Returns a `ComponentDefinition` `{ componentId, libraryId, name?, elements, files }` to save. |
| `materializeMaster(api, instanceGroupId)`     | Rebuilds the master next to that instance (40 px to its right) from the instance's own elements, with the instance transform undone and its overrides replaced by `mv`. Fails if a master is already on the canvas. Returns the new master group id.                                   |
| `adoptInstanceAsMaster(api, instanceGroupId)` | Turns the instance into the master in place, restoring master values from `mv` (for a machine whose library lacks the component). Returns its group id.                                                                                                                                |

Masterless edits go through `library.ts`:

- `withMaster(draft, cid, fn, instance?)` rebuilds the master in the draft, runs `fn`, syncs and
  takes the master away again, so it never commits. Commands that need a master (insert,
  properties, nesting) are wrapped in it; `materialize` gives master elements new ids each time,
  so address them by **slot**.
- `applyMasterEdit(draft, cid, edited)` replaces the master's elements with `edited` (as
  returned by `masterSnapshot`, then edited) and updates every instance. The host wrapper
  `applyComponentMasterEdit(api, cid, edited, files?)` adds the files and commits it all as one
  undo step and one collab update. This is the master-edit overlay's Done (FR-66).
- `masterSnapshot(elements, cid, instance?)` returns the master rebuilt from an instance (fresh
  ids each call), for thumbnails, save to My components and the overlay.
- A library instance records the master's look (`ms`: fill style, stroke width and style,
  sloppiness, edges, font, alignment, arrowheads). These keys can't be overridden, so a direct
  edit to them reverts to `ms`, and `materialize` rebuilds the master with them.

The definition's `elements` are clones of the master after tagging, so instances inserted
from it already carry `source: "library"`. `files` lists the image `fileId`s they use. While a
master is materialized, the usual rule syncs it, and collab peers receive the result without
echoing it.

## 4b. Component properties (FR-56)

A master can declare typed **properties** that drive keys of its slots (D-DX11). Each instance
sets its own values; a value is an override the property computes, so unset properties follow the
master and its default.

| Type      | Value            | Drives (default binding)                                               |
| --------- | ---------------- | ---------------------------------------------------------------------- |
| `text`    | string           | `text` (a container slot drives its bound label)                       |
| `color`   | `#rrggbb` string | `backgroundColor` or `strokeColor`                                     |
| `boolean` | true / false     | `visible`: false soft-deletes the slot in that instance (default true) |
| `choice`  | one of `options` | Any overridable key per option via `map` (absent = the master's value) |

- A property binds one or more slots (`bindings: [{ slot | elementId, key?, map? }]`). Choice
  needs at least two options.
- Precedence per instance child: nested values (`npv`) ← property values (`pv`) ← explicit
  overrides. Setting a property value clears explicit overrides on its bound keys.
- A direct edit to a key bound to a text or colour property updates that property's value, not an
  override, so the panel and agent see it.
- Removing a property drops its values from every instance; they go back to the master's look.
- Actions: `defineProperty`, `removeProperty`, `setProperties` (`null` resets a value) and
  `instanceProperties`. Host wrappers `defineComponentProperty`, `removeComponentProperty`,
  `setInstanceProperties` are one undo step each and return null (with a toast) on error or in
  view mode.
- UI: the **Properties** panel section (`src/components/componentProps/`, id `componentProps`).
  On a master it lists, removes and declares properties (name, type, bound element; choice
  options as `Name=value, …` driving fill, stroke, text or opacity). On an instance it edits each
  value (text field, colour, checkbox, select) with a reset button, then the values of nested
  components that declare properties.

## 4c. Nested components (FR-57)

A master can hold instances of other components: select whole instances (with or without other
shapes) and create a component, or `insertInstance(..., { into: masterGroup })`. B's instances
then hold **owned** copies of the A instances in B's master. Those copies still follow A (through
B's master) and keep B-level overrides.

- **Cycles** are rejected: A can't nest B if B (transitively) nests A, nor itself.
- **Update order**: `syncCascade` syncs a component, then every outer component whose master
  content it changed, until stable. A master edit of A reaches B's master and B's instances in
  the same undo step.
- **Overrides at both levels**: an override on the A instance inside B's master reaches every B
  instance; an override on a B instance's copy is kept per B instance. An outer instance sets the
  nested instances' property values with `setProperties(..., { nested: groupInMaster })` (`npv`).
- **Duplicate and paste** copy nested tags per component; a copied B master is a B instance with
  new owned A copies.
- **Orphans**: deleting B's master promotes a B instance; its A copies become free A instances.
  Detaching a B instance frees its A copies the same way.
- **Collab and undo** behave like single-level components: one undo step, no echo
  (`components.collab.real.test.tsx`).
- `list_components` counts owned copies as instances, with `parent` naming the outer instance.

## 5. Duplicate, paste and Alt-drag (`onDuplicate`)

`componentsOnDuplicate` runs inside Excalidraw's duplicate, paste and Alt-drag action, so its
result is part of that single undo step:

- A copy of a whole master (new group) becomes a new **instance**.
- **Alt-drag**: Excalidraw leaves the new ids behind and keeps dragging the originals. By the
  time it calls `onDuplicate`, the originals have moved one step, but each copy sits in its
  original's z-order slot and the originals are appended. When every master copy is in that
  position (or exactly on its original), the roles swap: the stationary copies stay the master
  and the dragged originals become the instance. A real-mouse drag covers this in
  `e2e/component-properties.spec.ts`.
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
| `createComponentFromSelection(api, name?)`         | Create from the selection; it becomes the first instance and selected   |
| `applyComponentMasterEdit(api, id, els, files?)`   | Replace the off-canvas master and update instances (one undo step, §4a) |
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

## 7a. UI: Components tab, panel section, My components (FR-55)

Code lives in `src/components/componentsUi/`, and the personal store in `src/lib/componentLibraryStore.ts`.

- **Components tab** (`ComponentsPanel.tsx`) is a `SidebarTabs` tab next to Layers. It has three lists, each with `exportToSvg` thumbnails:
  - **In this drawing**: this drawing's components (thumbnails from the off-canvas master).
  - **My components**: the personal cross-document library.
  - **From your library**: Excalidraw library items, each with a **Make component** action.
  - Click a row to place an instance at the viewport centre, or drag it onto the canvas. Either way it's one undo step.
  - My components rows can also be renamed, removed, or exported as `.excalidrawlib`.
- **My components** is stored in app data per profile (`my-components.json`), following the pattern of `libraryStore.ts`:
  - Changes fan out to every tab.
  - A failed load never wipes the file.
  - Collab guests can't save to it.
  - Outside Tauri it lives in memory.
  - Each entry is a snapshot of the master's elements plus the `BinaryFiles` they reference, so image components work. Excalidraw's own library rejects images. On insert the files go through `api.addFiles` first.
  - `.excalidrawlib` can't carry files, so export drops images, with a warning.
- **Inserting** a My components entry:
  - If the drawing already has the component, it places an instance of its own design.
  - Otherwise it places only an instance tagged `source:"library"` (§4a): the master stays in My components.
  - When the library-master engine is missing, the master is placed beside the instance instead.
- **Panel section** (`ComponentSection.tsx`, in `PANEL_SECTIONS`) appears when the selection is a component.
  - Plain shapes: **Create component**.
  - Master (legacy drawings, or inside the master editor): **Save to / Update in My components**.
  - Instance: **Edit master…**, **Save to / Update in My components**, **Reset overrides**, **Detach**, and a per-slot override list with a reset for each slot.
  - "Update in My components" and the summary's "· from My components" appear only when My components really has the entry (`linkedEntryId`, the master editor's "Also update in My components" rule). A created or demoted component carries a library link before it is saved, so it shows "Save to My components" until then.
- **Edit master…** (FR-66, D-DX20), from the Component row or the pencil on an **In this drawing** row, opens the master editor (`MasterEditor.tsx`): a temporary second `<Excalidraw>` laid over the drawing.
  - An accent header names the component and its instance count, with **Cancel** and **Done**.
  - The master is placed on the instance it was opened from, at the same viewport; the rest of the drawing around it shows as dimmed, locked copies for context (`masterEditScene.ts`). The drawing itself never holds the master.
  - **Done** (or Cmd/Ctrl+Enter) applies the edit with `applyComponentMasterEdit`: every instance updates, overrides survive, one undo step and one collab update. An unchanged edit closes without an undo step.
  - When the component is linked to My components, a checked **Also update in My components** box saves the edited master there as well.
  - **Cancel** changes nothing. Esc is layered: Excalidraw's own uses first, then leaving group edit, then deselecting, then Cancel.
  - Limits: a scaled or rotated instance shows the master at its own size and angle, centred on the instance; bindings to context copies are dropped; context covers the viewport plus one viewport around it.
- **Create** is available from Alt/Option+Cmd/Ctrl+K, the panel, and **Edit → Create Component** in the native menu (`excalidraw:edit:createComponent`, no accelerator because the shortcut is handled in the webview).

## 8. Agent tools

`create_component` (the selection becomes the first instance), `insert_instance` (`into` nests
it in another component), `list_components`, `get_component_master` and `edit_component_master`
(read and edit the off-canvas master by slot, positions relative to its top-left), `set_overrides`, `reset_overrides`, `detach_instance`, `define_property`, `remove_property` and
`set_properties` (`nested` targets a nested instance) are described in `docs/ai-integration.md`, along with
`list_my_components` and `insert_my_component` for My components (§7a). All of the edit tools
work inside `apply_ops`.

`get_scene_summary` rows carry
`cmp: { id, role, slot, group, overrides?, values?, in? }` (`values`: property values; `in`:
components nested in it), and `get_elements` returns a `components` map.

Generic edits made through `update_elements`, `delete_elements` and similar tools re-sync the
components they touch within the same draft. They follow the same rules as UI edits: master
edits propagate, overridable instance edits become overrides, and other instance edits are
reverted.

## 9. Out of scope and caveats

- Properties: a master's own nested property values (`npv` set on B's master) aren't restored
  by `materializeMaster`. A choice option with no `map` entry for a nested binding keeps the
  nested master's look. A property value can't show a slot the master itself hides.
- Named styles are a separate rule that runs before this one (`docs/styles.md`, D-DX12). A
  styled master child carries its style to instances as a master change, not an override.
- My components entries are snapshots. Updating one doesn't re-sync other drawings that already
  hold instances of it: their library-backed instances update the next time their master is edited
  there with Edit master… → Done.
- `.excalidrawlib` export drops images (the format has no files); the UI warns.
- Arrow labels have only light test coverage. Bound text in rotated instances is covered by a
  real-Excalidraw test (it stays centred and rotated with its container).
- A component's elements must all share one frame, or none. Each instance keeps its own frame.
- Smart containers (`docs/containers.md`) work with components: a container inside a master is
  synced to instances like any other children (their copy of the box is inert), and an instance
  can be a container child. The container moves it as one unit without creating overrides.
