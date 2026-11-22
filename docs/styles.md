# Named styles (FR-58, D-DX12)

A named style is a reusable look. Elements link to a style, and editing the style updates every
linked element live. Each element can still override single properties locally.

Code: `src/extensions/styles/` (model, sync, rule, actions, host) for the engine,
`src/components/styles/` for the properties-panel Style row. There is no separate Styles
sidebar tab (removed by D-DX19).

## 1. Data model

Stock Excalidraw saves, syncs and round-trips only element data (D-DX2). So a style has no
scene-level record. Its definition is **denormalized onto every linked element**, in
`customData["excalidrawDesktop.style"]`:

```jsonc
{
  "v": 1,
  "id": "kH3…", // style id
  "name": "Primary",
  "rev": 4, // bumped on every definition edit
  "props": { "strokeColor": "#1971c2", "strokeWidth": 2, "fontFamily": 6 },
  "overrides": { "strokeColor": "#e03131" }, // this element only (optional)
}
```

Consequences:

- **A style exists while at least one live element links to it.** Unlinking or deleting the last
  element removes the style, and undo brings it back. Deleting a style from the UI unlinks its
  elements; they keep their current look.
- Styles survive save, reload, copy/paste across files and collab with no extra format work.
  Pasting a styled element into another file brings the style along.
- `v` lets a future version change the format; a tag this version can't read is ignored.

### Properties

| Key                              | Value                                       |
| -------------------------------- | ------------------------------------------- |
| `strokeColor`, `backgroundColor` | colour                                      |
| `fillStyle`                      | hachure, cross-hatch, solid, zigzag         |
| `strokeWidth`                    | number                                      |
| `strokeStyle`                    | solid, dashed, dotted                       |
| `roughness`                      | 0–2 (Architect, Artist, Cartoonist)         |
| `opacity`                        | 0–100                                       |
| `roundness`                      | round, sharp                                |
| `fontFamily`                     | font id or name (Excalifont, Nunito, …)     |
| `fontSize`                       | number                                      |
| `textColor`                      | colour (stored as the text's `strokeColor`) |

Shapes, lines, arrows and freedraw take the first eight keys (`roundness` only where Excalidraw
supports it: not on ellipses, freedraw or elbow arrows). Text, including bound labels, takes
`fontFamily`, `fontSize`, `textColor` and `opacity`. Images take `opacity` and `roundness`.
Frames take nothing. `applies(el, key)` in `model.ts` is the source of truth. A key that doesn't
apply to an element is simply skipped for it, so one style can cover a box and its label. Linking a shape also links
its bound text. Font changes re-measure the text (bound labels re-layout in their container).

## 2. Sync

`syncStyle(styleId, access, memory?)` in `sync.ts` makes every member match its style:

1. **Winner.** The definition with the highest `rev` among live members wins. Ties (two peers
   edited at once) go to the larger `JSON.stringify([name, props])`, so every peer picks the
   same one regardless of order.
2. **Direct edits become overrides.** If a member's value for an applied key differs from what
   its own tag says it should be (and from the value last seen, when the live rule knows it),
   the user changed it directly, so it is recorded in `overrides`. A value equal to the style's
   drops the override.
3. **Apply.** Every member gets the winning tag, overrides cleaned to keys the style still sets
   and that apply to it, and the resulting element values.

The sync is pure over a small access interface, so the same code runs live and in the draft
actions. That way every command's single undo step is already consistent.

### Live: the reactor rule

`createStyleRule()` (`rule.ts`) links every tagged element, except component instance children,
as a target of its style id. Any change to a member re-runs `syncStyle` for that style. It runs
on the shared reactor (D-DX1) with `apply: "mutate"`, so:

- an edit and the style sync it causes are **one undo step**;
- collab applies are tagged remote, so only the editing peer propagates. Other peers receive the
  already-synced elements and don't echo.

### Rule order: styles before components

`installComponents` installs `[createStyleRule(), createContainerRule(), createComponentRule()]`
on one reactor (containers: `docs/containers.md` §3). The reactor runs key-level rules **in
order** and **chains their writes**: elements a rule writes in a flush count as changes for the
later rules in the same pass. Earlier rules never re-run for later writes unless they opt in with
`seesLaterWrites` (next pass, bounded by `maxPasses`); only the container rule does. This is a small, generic part of `src/extensions/reactor/reactor.ts`, covered by
`reactor.real.test.tsx`.

Why styles first:

- **A style edit reaches instances.** Editing a style restyles the master's linked children.
  Components then sees those as master edits and updates every instance in the same flush, so
  the whole thing is one undo step.
- **It is never an instance override.** Instance children are not style members (`links`
  excludes them), so the styles rule never writes to them. Their new look arrives through the
  components rule as a master change, which is not recorded as an override.
- **Components last can't be undone by styles.** Components writes only instance children,
  which styles ignores, so no ping-pong. Containers write only positions and box sizes, never
  style keys, so a later pass that re-checks a styled element finds nothing to change.
- **Containers in between.** A font change grows text, the container holding it re-flows, and
  components carries both to instances, all in one flush and one undo step.

The other order would let components copy the master's _old_ look to instances before styles
updated the master, needing a second flush and a second undo step.

Instance children carry no style tag of their own: components copies only the master's look.
`elementStyleInfo(el, get)` reports their style from the master slot with `fromMaster: true`, and
the panel shows "Follows its component master" for them. Style actions reject instance children.

The agent path (`runEdit` in `sceneTools.ts`) mirrors this order: `syncStylesEdited(draft)`, then
the container re-flow (`reflowEdited`), then the components `syncEdited(draft)`.

## 3. UI

- **Properties panel → Style** (`stylePanelSection`, after Stack, before Data): a picker with
  None, every style, and "New style from selection…", plus **Rename** and **Delete style** for the
  linked style. Instance-only selections show the master's style read-only. When targets have
  overrides it shows them with **Reset overrides** and, for a single element, **Update style**
  (pushes its overrides into the style); that is how a style's properties are edited in the UI.
- The row shows only while the selection uses a style (FR-65): linked, overridden, or following a
  styled master. Otherwise the strip's **"+"** row offers **Apply style**, which reveals it.

Every UI action is one undo step (`runStyleCommand` → `commitUndoable`).

## 4. Agent tools

| Tool                    | What it does                                                              |
| ----------------------- | ------------------------------------------------------------------------- |
| `list_styles`           | Styles with props and linked element ids; no undo step                    |
| `create_style`          | New style from `ids` (their look, or explicit `props`), linked to them    |
| `apply_style`           | Links `ids` to a style (dropping their overrides), or unlinks with `null` |
| `update_style`          | Renames and/or changes props (`null` removes one); linked elements follow |
| `delete_style`          | Unlinks every element; they keep their look                               |
| `reset_style_overrides` | Clears local overrides on `ids` (all, or some `keys`)                     |

All edit tools work in `apply_ops`. Generic edits (`update_elements` etc.) that touch a styled
element's style keys become overrides. `get_elements` and the scene summary report `sty`
(`id`, overridden keys, `fromMaster`).

## 5. Caveats

- **Stale tags.** Components' `deriveChild` keeps an instance child's own `customData`, so a child
  that was styled before it became an instance keeps an inert tag. Promoting or detaching the
  instance makes it a member again, and it rejoins that style (taking the winning definition).
- **Concurrent edits** to one style on two peers converge by `rev`, then the deterministic
  tie-break. The losing edit is dropped, not merged.
- **Denormalized storage** means a definition is repeated on each linked element. That is fine
  for diagram-sized styles.
- No style inheritance, no scene-level style library, no text-alignment or arrowhead props yet.
- Text-width reflow under font changes is covered by unit tests; jsdom doesn't scale text width,
  so the Playwright smoke checks colours.
