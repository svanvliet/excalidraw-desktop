---
description: Walk pre-release validation — bump version, regenerate changelog, run lint + all tests on both platforms, verify status milestones, tag.
argument-hint: <new-version e.g. 0.2.0>
---

You are running the pre-release checklist for Excalidraw Desktop. The
target version is **`$ARGUMENTS`** (semver — e.g. `0.2.0`,
`0.2.0-rc.1`). If empty, ask the user before doing anything else.

# Hard rule

If any step fails, **stop**. Do not paper over a failure to get to the
tag. The whole point of this checklist is to keep the `main` branch
shippable.

# Checklist (track via TODOs)

1. **Verify clean tree.** `git status` must be empty. Refuse to
   continue if there are uncommitted changes.
2. **Verify branch + sync.** Must be on `main`, up to date with
   `origin/main`. `git fetch && git status -sb` — abort if `behind`.
3. **Verify all milestones complete.** Read `docs/status.md`. Every
   row in the milestones table must be ✅ or 🗓 (deferred). Refuse if
   any row is ⬜, 🟡, or ⏸ unless the user explicitly tells you to
   ship anyway.
4. **Bump the version everywhere.**
   - `package.json` `version`
   - `src-tauri/Cargo.toml` `[package] version`
   - `src-tauri/tauri.conf.json` `version`
     Run `npm install` so `package-lock.json` picks up the new version.
     Run `cargo update --workspace -p excalidraw_desktop_lib` (or just
     `cargo build` once) so `Cargo.lock` updates.
5. **Run the full `npm run check`.** Must be green. No warnings.
6. **Run `npm run e2e`.** Must be green (3 chromium tests including
   the zero-outbound-requests privacy regression).
7. **Try a release build locally** as a sanity check. If you're on
   macOS, `npm run tauri build`; if on Windows, the same. Capture the
   artifact path. (Don't sign here — that's a separate workflow.)
8. **Update / regenerate the changelog.**
   - `CHANGELOG.md` (create if missing) gets a new `## [<version>] -
<date>` section with categorized bullets (Added / Changed /
     Fixed / Removed / Security / Deferred).
   - Source the bullets from `git log --pretty=format:"%s" <prev-tag>..HEAD`
     and group by Conventional Commits scope (`feat:` → Added,
     `fix:` → Fixed, `chore(deps):` → Changed, etc.).
9. **Append a status changelog row** in `docs/status.md` under
   "Changelog of status changes" recording the release date + version.
10. **Commit the version bump + changelog** with subject
    `chore(release): v<version>`. Body lists what's in the release at
    a high level. Include the `Co-authored-by: Copilot <…>` trailer.
11. **Tag.** `git tag -a v<version> -m "Release v<version>"`.
12. **Do NOT push automatically.** Print the suggested next commands
    and let the user choose to push.

# Pending platform verification

If the user has never run `npm run tauri dev` on both macOS and
Windows since the last release, surface that **before** tagging.
Look in `docs/status.md` for "pending user-side manual verification"
checklist items. Refuse to tag if any of those are unticked unless
the user overrides explicitly.

# Final report

- Old version → new version.
- Status of every milestone (copy the table).
- Test counts (Vitest + cargo + Playwright).
- Release artifact path (if built locally).
- Commit SHA + tag.
- The exact `git push` + `git push --tags` commands the user can run.
