---
description: Bump @excalidraw/excalidraw, read its changelog, run tests, and report any breaking changes the bump introduces.
argument-hint: [target-version-or-latest]
---

You are upgrading `@excalidraw/excalidraw` in this repository. The user
supplied **`$ARGUMENTS`**: if it's a version (e.g. `0.18.0`) bump to
that; if it's empty or `latest`, bump to the latest published.

# Why this is delicate

Excalidraw's component API is the entire surface we expose to users.
Its `aiEnabled`, `isCollaborating`, `libraryReturnUrl`, and
`exportEmbedScene` props are referenced in our code; its imperative
API (`getSceneElements`, `getAppState`, `getFiles`) is used by
`src/lib/png.ts` and `src/components/ExcalidrawCanvas.tsx`. A minor
bump can quietly rename a prop. We want loud failures, not quiet ones.

# Plan to execute

Use a TODO list.

1. **Capture the current version** from `package.json` and
   `package-lock.json`. Record it for the report.
2. **Resolve the target version.**
   - If the user gave one, use it verbatim.
   - Otherwise run `npm view @excalidraw/excalidraw version` and use
     that.
   - If old == new, stop and report "already on latest."
3. **Read the upstream changelog** for the version range you're
   crossing (old → new). Fetch from:
   - https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/CHANGELOG.md
   - Or the npm tarball's `CHANGELOG.md`.
     Summarize every entry between the two versions, flagging anything
     that looks like a removed/renamed prop, a changed default, or a
     change to the exported types of `getSceneElements` /
     `restoreElements` / `loadFromBlob` / `exportToBlob`.
4. **Update the dependency.**
   - `npm install @excalidraw/excalidraw@<target>`
   - Verify `package.json` + `package-lock.json` updated.
5. **Run the type checker first.** `npm run typecheck`. TypeScript is
   the cheapest first signal for API drift. Capture the diagnostics
   verbatim if it fails.
6. **Run the full check.** `npm run check`. Capture any failures.
7. **Run the web-build smoke suite.** `npm run e2e`. This is the
   privacy regression test and the React-shell test.
   - If chromium isn't installed yet: `npm run e2e:install` first.
8. **If anything failed**, work through the failures using the
   changelog you read in step 3 as your guide. Fix the call sites we
   own (most likely `src/components/ExcalidrawCanvas.tsx` or
   `src/lib/png.ts`). Do NOT rewrite the public Excalidraw API or fork
   the package.
9. **Re-run `npm run check` + `npm run e2e`** until both are green.
10. **Commit** with a conventional-commits subject:
    `chore(deps): bump @excalidraw/excalidraw <old> -> <new>`. The
    body must include:
    - A bullet list of breaking changes you handled.
    - A bullet list of behavioral changes that _could_ affect users
      but didn't require code changes (these go in the user-facing
      changelog later).
    - The `Co-authored-by: Copilot <…>` trailer.

# Things to never do

- Pin to a specific minor without writing down why.
- Skip the smoke suite because "it's only a patch bump."
- Disable a failing test to make the bump green.
- Add a workaround that re-introduces a code path Excalidraw
  removed for security/privacy reasons.

# Final report

When done, produce a short report:

- `<old> -> <new>` (or "no change").
- Test counts before and after.
- Breaking changes you handled, with file references.
- Behavioral changes worth noting in user-facing release notes.
- Commit SHA.
