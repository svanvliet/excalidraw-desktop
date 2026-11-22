# Smart containers

Auto-sizing horizontal or vertical **stacks** with gap, padding and alignment, like a Figma
auto-layout frame. Children re-flow live as they change. FR-59, D-DX13. Code:
`src/layout/containers/`. The panel section is in `src/components/containers/`.

## 1. Representation

A container is an ordinary Excalidraw **group** plus one tagged **background rectangle** (the
_box_) inside it. The box carries the definition in its `customData`:

```jsonc
"excalidrawDesktop.layout": {
  "v": 1,
  "container": {
    "direction": "vertical",          // or "horizontal"
    "gap": 16,
    "padding": { "top": 16, "right": 16, "bottom": 16, "left": 16 },
    "align": "start",                 // cross axis: start | center | end
    "justify": "start",               // main axis: start | center | end | space-between
    "sizing": { "w": "hug", "h": "hug" }, // hug the children, or keep a fixed size
    "gi": 0                           // index in box.groupIds of the container's group
  }
}
```

Why a group plus a box instead of a frame:

- A frame clips its children and can't be nested or grouped. Groups nest, so containers can nest
  inside containers, sit inside a component master and be moved by auto-layout as one node.
- The box is a real rectangle, so users can style it (fill, stroke, roundness), bind arrows to
  it and label it. It also renders in stock Excalidraw. A file opened there shows the last
  layout as plain shapes in a group.

The tag is ignored (the group behaves as a plain group) when the box is deleted, rotated, has an
invalid or newer tag, or is a component instance's copy of a master box. Instances follow their
master's layout through component sync, not their own rule.

## 2. Children and order

The direct children (_units_) of a container are:

- an element whose innermost group is the container (plus its bound text), or
- a whole next-inner group: a user group, a nested container or a component instance.

Arrows and lines bound to children aren't children. They follow the children instead.
Order is by main-axis centre, then z-order, so dragging a child past its sibling reorders the
stack. Commands that set an explicit order (Move up/down, `update_container` `order`) place the
children so the next re-flow keeps it.

`justify` only applies when the main axis is fixed. A hug axis is always exactly as big as the
children plus gaps and padding.

## 3. Live re-flow

`createContainerRule` (`rule.ts`) is a key-level reactor rule (D-DX1), with the group id as the
key. Every grouped element is a target of each of its groups, and a box is the source of its
own group. Any change inside a container therefore re-flows it: a move, resize, text edit that
grows a label, added or deleted child, undo or redo. The rule uses `apply: "mutate"`, so the
re-flow folds into the user's own history entry. That gives **one undo step** per user action,
and Redo stays available. Collab applies are tagged remote (`remoteApi`), so only the editing
peer re-flows and peers receive the result without echo. Arrows bound to anything that moved
follow it.

**Gestures.** While the user drags, resizes or rotates, or draws a new element, those elements
are _held_. Siblings re-flow around a held unit live, but the held unit itself isn't snapped.
`createHoldTracker` watches `onChange`. When the gesture ends it calls `reactor.invalidate()`
for the held ids, so the container settles and snaps them into their slots.

Nested containers re-flow inner first, then outward. The rule shares the components reactor,
in the order `[style, container, component]` (see `docs/styles.md` § "Rule order"): a style
font change grows a text, its container re-flows, and components carries both to instances in
one flush. A rule's writes dirty later rules in the same pass. The container rule also opts
into later rules' writes (`seesLaterWrites`, next pass, bounded by `maxPasses`), so an instance
that the component rule resizes re-flows the container holding it. A container that moves an instance never turns that into overrides.

## 4. Commands and UI

`host.ts` runs every command on a `Draft` and commits it with `commitUndoable`, so the command
and its re-flow are one undo step. It flushes the reactor first and refuses in view mode.

The UI calls containers **stacks** (D-DX19); code, command ids and agent tools keep "container".

- **Make stack**: Alt/Option+Shift+A, **Layout ▸ Make Stack**, or "+" ▸ **Make stack** in the
  panel strip when 2+ elements are selected (no row is shown for a plain selection, FR-65). The
  new group is selected.
- The **Stack** properties-panel row:
  - **container mode** (a whole container selected): direction, align, gap, padding, size W/H
    (hug or fixed), distribute (when the main axis is fixed) and **Remove stack**.
  - **child mode** (one child selected inside a container): "Item i of n", Move up/down (or
    left/right) and **Take out of stack**, plus the parent container's settings.

**Command registration.** `commands.ts` (`CONTAINER_COMMANDS`, `runContainerMenuCommand`,
`registerContainerActions`) is the single place that registers the container commands. Menu
ids are `excalidraw:layout:makeContainer` and `excalidraw:layout:removeContainer`. They're listed in
the top-level **Layout** menu and the toolbar's Layout dropdown via the shared
`src/layout/commands.json`; `src/layout/commands.ts` delegates to `run` here.

## 5. Agent tools

`create_container`, `update_container` (settings and/or `order`), `remove_container`
(`keepBox` keeps a plain group), `add_to_container`, `remove_from_container` and the read-only
`list_containers`. All edit tools work inside `apply_ops`. After any agent edit, the containers
it touched re-flow in the same draft, after styles sync and before components sync, so `update_elements` on a child
behaves like a user edit.

## 6. Interactions

- **Auto-layout** (`src/layout/graph.ts`) moves the outermost group as one node, so a container
  keeps its stack and moves as a whole.
- **Components**: a container can sit inside a master, and instances follow. An instance can be
  a container's child, moved as one unit with no overrides.
- **Frames**: a container's elements must share one frame (or none).

## 7. Caveats

- Rotated boxes switch the layout off rather than laying out in rotated space.
- Wrapping (multi-line stacks), per-child grow/fill and absolute-positioned children are out of
  scope.
- Hand-moving a child off its slot is undone by the next re-flow, by design. Take it out first.
- Excalidraw's own "Ungroup" on a top-level container leaves a tagged box with no group, which is
  inert. But ungrouping a container's group while inside an outer group shifts the box's group
  index onto the outer group, which then becomes a container. Undo, or **Remove container**,
  restores it. Use **Remove container** rather than Ungroup.
