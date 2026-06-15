---
description: Scaffold a new Tauri command (Rust handler + registration in lib.rs + typed TS wrapper + Vitest + cargo test stubs).
argument-hint: <command_snake_case_name> [one-line description]
---

You are scaffolding a new Tauri command end-to-end. The user wants the
command **`$ARGUMENTS`** added cleanly to this codebase. If
`$ARGUMENTS` is empty, ask the user for the command name (snake_case)
and a one-line description before doing anything else.

# Goal

Wire up a brand-new Tauri command with the minimal amount of code, in
the conventions this repo already uses, with tests on both sides, and
without breaking `npm run check`.

# Required reading before writing any code

Read these files first so you copy the existing conventions exactly
rather than inventing new ones:

1. `src-tauri/src/commands/files.rs` — canonical example of a Rust
   command module: `#[command]` handlers, `Result<T, AppError>` return
   type, `#[cfg(test)] mod tests` with table-driven cases using
   `tempfile`.
2. `src-tauri/src/error.rs` — the `AppError` enum and its
   `serde::Serialize` impl. New error variants live here.
3. `src-tauri/src/lib.rs` — the `invoke_handler` registration site and
   the `mod commands;` declaration.
4. `src/ipc/commands.ts` — TS wrappers: every command is gated by
   `isTauri()` and degrades gracefully in the web preview build.
5. `src/ipc/commands.test.ts` — wrapper test pattern (mocks
   `@tauri-apps/api/core`).
6. `CLAUDE.md` §3 "Core conventions" — covers privacy, capabilities,
   secrets, test, and commit rules. Particularly: every new capability
   addition must update `docs/plan.md` §5.

# Plan to execute

Use a TODO list. Mark each step in-progress before starting and done
when complete. Default order:

1. **Decide the command signature.** Parameters, return type, error
   modes. If parameters are file paths, use `&Path` / `PathBuf`. If
   they are bytes, use `Vec<u8>` (with base64 over the wire — see
   `read_file_bytes` for the established pattern).
2. **Create / extend `src-tauri/src/commands/<module>.rs`.** Follow
   the `files.rs` shape: `use` block, `#[tauri::command]` async fn,
   table-driven `#[cfg(test)] mod tests` using `tempfile` /
   `tokio::test` as appropriate.
3. **Register the module + command** in `src-tauri/src/lib.rs`:
   add `mod commands` line if needed, and add the command to the
   `tauri::generate_handler![...]` list.
4. **Add the TS wrapper** in `src/ipc/commands.ts`:
   - Define / extend the typed parameter + return interfaces.
   - Wrap `invoke(...)` in an `if (!isTauri()) { ... }` guard that
     either rejects with `AppError.NotInTauri` (for file-ops style)
     or no-ops / returns a safe default (for scratch / list style),
     matching the most similar existing command.
   - Re-export the wrapper from `src/ipc/commands.ts`.
5. **Add Vitest coverage** in `src/ipc/commands.test.ts`:
   - At least one happy-path test that mocks `invoke` and asserts the
     invocation args + return value plumbing.
   - At least one `isTauri() === false` test asserting the web-preview
     fallback behavior.
6. **Add cargo coverage** in the same Rust file under
   `#[cfg(test)] mod tests`:
   - Happy path.
   - Each error variant the command can return.
7. **Capability check.** If the command needs filesystem, dialog,
   keyring, deep-link, or any plugin scope not already in
   `src-tauri/capabilities/default.json`, add it AND add a row to
   `docs/plan.md` § "Tauri capabilities (minimal allowlist)".
8. **Run `npm run check`.** It must be green. Fix every warning;
   `eslint` is configured `--max-warnings 0` and `clippy -D warnings`.
9. **Commit** with a conventional-commits subject:
   `feat(<scope>): add <command_name> command`. Include the
   `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
   trailer per CLAUDE.md § Commits.

# Conventions to respect

- **Privacy.** A new command must not introduce an outbound network
  call unless the user explicitly asked for one AND it's behind a
  settings toggle that defaults off. See CLAUDE.md § 8.
- **Error shape.** Always return `Result<T, AppError>`. Add a new
  variant to `AppError` rather than smuggling errors through `String`.
- **Async by default.** Tauri commands should be `async fn` unless
  there's a specific reason to block. Filesystem IO uses
  `tokio::fs::*`.
- **No `unwrap()` / `expect()`** in non-test code. Map to `AppError`.
- **No new top-level dependencies** without a one-line justification
  in the commit body.

# When you're done

Report back with:

- The command name + signature.
- Files touched.
- Test counts before vs after (`npm test`, `cargo test`).
- The commit SHA(s) you produced.
