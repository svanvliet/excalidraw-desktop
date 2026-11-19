# AI agent — manual validation matrix (AI-6 gate)

> Run on a **release build** on macOS and Windows before any release that enables the AI panel.
> Design: `docs/ai-integration.md`. Automated coverage (Vitest, cargo, Playwright against a fake ACP agent) runs in `npm run check` / `npm run e2e`.

## Matrix

Run every scenario for each cell. Record build version, engine version, and pass/fail in `docs/status.md` § AI-6.

|                    | macOS | Windows |
| ------------------ | ----- | ------- |
| GitHub Copilot CLI |       |         |
| Claude Code        |       |         |
| OpenAI Codex       |       |         |

## Scenarios

1. **Privacy, AI off:** fresh profile, AI master toggle off. Use the app for 5 minutes and confirm that no engine process ever starts (Activity Monitor / Task Manager) and the webview makes no network traffic.
2. **Detection:**
   - Engine installed via each supported method (npm global, Homebrew/winget, native installer) is detected with path + version, including when the app is launched from Finder or the Start menu (GUI PATH).
   - The custom path override works.
   - `.cmd` shims on Windows work.
3. **Not logged in:** sign out of the engine. The panel shows the "not logged in" state with the correct sign-in command. After signing in, Re-detect recovers without restarting the app.
4. **Not installed:** rename the binary. The panel shows install guidance; no crash.
5. **Diagram from description:** "Draw a login flow with 5 steps". Elements appear live, the turn is a single ⌘/Ctrl+Z, and Revert turn removes them.
6. **Edit selection:** select 3 shapes and ask "make these blue and align them". Only the selected shapes change.
7. **Mermaid:** ask for a sequence diagram. Editable elements are inserted with no CSP errors in devtools.
8. **Sandbox:** ask the agent to "run `ls` / create a file in my home folder". It refuses or gets denied; no file is created. The engine's built-in shell and write tools are absent.
9. **Host MCPs toggle:**
   - On: a user-configured MCP tool that isn't known read-only triggers an approval card. "Allow for this conversation" stops later prompts.
   - Off: the tool is not offered.
10. **Attach folder:** attach a repo folder and ask "diagram this project's modules". Files are read; writes are impossible.
11. **Stop / crash:** Stop mid-turn cancels within 2 s. Kill the engine process; the panel shows Retry, and no orphaned processes remain after closing the tab or quitting.
12. **Collab:** host a session with a browser guest. Agent edits appear for the guest. In a viewer tab, the agent is disabled.
13. **Resume:** quit and relaunch. The conversation's engine session resumes (or a clear "started a new session" notice appears).
14. **Text-to-diagram dialog:** Excalidraw's "Text to diagram…" generates through the default engine.

## Release gate

- [ ] All cells pass.
- [ ] Legal/terms review recorded for each engine's subscription use from a third-party app (especially Claude Code, see `docs/ai-integration.md` § Decisions D-AI6).
