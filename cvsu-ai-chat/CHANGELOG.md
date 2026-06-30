# Changelog

All notable changes to CvSU-AI VSCode Chat are documented here.

## 0.17.2
- **Fixed “request exceeds the available context size” on large files.** Asking
  the agent to `/refactor` (or otherwise act on) a big file could blow past the
  model's window and error out instead of trimming to fit. Two causes, both fixed:
  - History trimming now **guarantees** the request fits the window — it budgets
    the leading system messages (system prompt + the embedded file context) too,
    and **truncates** any oversized message (including the newest) rather than
    sending it whole. Previously the lead was never trimmed and a single huge
    message was kept intact, so the request overflowed.
  - The agent **no longer re-reads the open file** it was already handed. Its
    contents are embedded in context, so a `read_file` on that same file is
    short-circuited — removing a double-count that doubled the request size.
- Net effect: large-file requests are clipped to fit (with a clear “truncated to
  fit the context window” marker) instead of failing.

## 0.17.1
- **Auto-compaction now actually works on the default context window.** The
  summarize request was sending a fixed ~24 000 characters regardless of the
  model's window, so on the default `localai.contextSize: 4096` the summarize call
  itself exceeded the window and silently fell back to a warning. The input is now
  **clipped to fit the window** (derived from `contextSize`, reserving room for the
  reply), so compaction succeeds. If it ever does fail, it won't re-attempt every
  message — it warns once and stops retrying for that chat.
- **“→ Continue” no longer leaves a phantom message.** The continuation is now
  merged into the previous reply instead of storing a synthetic “Continue…” user
  turn that reappeared as a bubble on reload.
- **Agent edits are more reliable.** When you ask for tests and a test file already
  exists, its **contents are now embedded directly** in the agent's context (when
  small enough), so the agent appends without a `read_file` round-trip — removing
  the most common cause of the agent looping on file reads.
- **Stale compaction notes** no longer linger when switching between saved chats.

## 0.17.0
- **Auto-compacting chat history.** When a conversation nears the model's context
  window, the older messages are automatically **summarized into a compact
  summary** and the chat continues — preserving context while freeing tokens, with
  no disruption (recent messages are kept verbatim). Like Claude Code's `/compact`.
  On by default (`localai.autoCompact`); falls back to a gentle warning if off.
- New command **CvSU-AI VSCode Chat: Compact Chat** to compact on demand anytime.

## 0.16.1
- **Context handling no longer kicks you out of the chat.** Instead of auto-
  clearing a long conversation, it now shows a **one-time, non-destructive note**
  and keeps the chat open (older messages are trimmed from requests behind the
  scenes). You decide when to start fresh. (Setting renamed to
  `localai.warnNearContextLimit`.)
- **Agent no longer loops on file reads.** `read_file` now:
  - returns a **file listing** when given a directory / `.` / `./` / empty path
    (the model often "explores" with read_file — now that works instead of erroring);
  - on a not-found path, returns the **actual available paths** so the model
    stops guessing;
  - re-reading a file it already read pushes it to **write** instead of re-reading.
- When the agent still can't apply an edit (usually a weak local model), it now
  gives **useful next steps** — switch to the 7B model, or click **Apply** on the
  code block — instead of a dead-end message.

## 0.16.0
- **Prompt history with ↑/↓.** In the composer, press **↑** to recall your
  previous prompts and **↓** to go forward (your in-progress draft is restored at
  the bottom). Works like a terminal; multi-line editing is preserved (↑ only
  recalls when the caret is on the first line).
- **Auto-free context near the limit.** When a conversation approaches the
  model's context window (~85%), it's saved to History and a fresh chat starts
  automatically — freeing the tokens and avoiding "exceeds context size" errors.
  A note explains it; the old chat stays in History. Toggle with
  `localai.autoResetNearLimit` (on by default).

## 0.15.1
- **Model picker moved to a dropdown in the composer row** (bottom), like
  Copilot/Claude — pick any model the server offers from a proper `<select>`
  instead of the header chip + popup. The reply footer still shows which model
  produced each answer.

## 0.15.0
- **Custom agents, skills, and project instructions** via a `.cvsuai/` folder in
  your workspace (run **CvSU-AI VSCode Chat: Set Up Custom Agents & Skills** to scaffold it):
  - `.cvsuai/instructions.md` — project rules prepended to **every** message
    (like `CLAUDE.md`/`.cursorrules`).
  - `.cvsuai/skills/<name>.md` — your own `/name` command (a prompt template;
    `$ARGUMENTS` is replaced with text you type after it).
  - `.cvsuai/agents/<name>.md` — your own `/name` **agent** that runs in agent
    mode (reads/edits files) with the system prompt you write.
  - Each file's `description:` frontmatter shows in the `/` menu. Changes are
    picked up live (no reload). Custom commands override built-ins of the same name.

## 0.14.0
- **Every reply now shows which model produced it** — the model name appears in
  the reply footer (next to tokens · tok/s).
- **Switch models from the chat header.** A model chip (top of the panel) shows
  the active model; click it to pick any model the server offers and switch
  instantly — no need to open settings or the command palette.

## 0.13.2
- **Cleaner layout in the narrow sidebar.** Short conversations now sit just
  above the composer (bottom-anchored, like Copilot) instead of leaving a large
  dead gap; the welcome screen stays centered. Long chats scroll normally.

## 0.13.1
- **Fixed a duplicate empty "•••" reply bubble** that could linger above the real
  answer when the agent took a step that produced no visible text.
- **Read-only slash commands (`/explain`, `/review`, `/ask`, …) now answer
  directly** instead of running the agent tool-loop — they work on the code
  that's already attached, so they no longer get stuck doing `read_file`. (File-
  editing commands like `/fix`, `/test` still use the agent.)
- **The agent can now read files you have open even if their folder isn't a
  workspace root** — `read_file` falls back to matching open editors, fixing the
  "path doesn't resolve in the open workspace" loop for files opened standalone.

## 0.13.0
- **Native sidebar, like Copilot/Claude.** The chat now lives in its own
  **Activity Bar** icon (left strip) as a dockable view — not a floating editor
  tab. Click the LocalAI icon to open it.
- **Auto-reopens on reload.** VS Code persists the view, so if it was open before
  a reload/restart, it comes back open (and restores your most recent chat).
- **＋ New** button in the view's title bar starts a fresh chat.
- **Fixed the `/test` "file not found" loop for real.** The agent's system prompt
  was still suggesting a top-level `tests/` path, which the model invented instead
  of using the file's actual directory. The prompt now defers to the exact paths
  provided and forbids guessing. Also fixed multi-root paths (selection paths no
  longer carry the folder-name prefix that broke resolution).

## 0.12.1
- **Fixed "request exceeds context size (4096)".** The client now sizes its input
  budget from a new **`localai.contextSize`** setting (the model's real window)
  instead of a hard-coded 4096. Set it to match your model — the **local** model
  is now configured for **8192**, so set `localai.contextSize` to 8192 locally.
- The local 7B model's `context_size` was raised 4096 → 8192 (safe now that
  parallel=1 + flash-attention + f16 KV keep the KV cache small; ~820 MB VRAM
  headroom remains).

## 0.12.0
- **Codebase RAG (semantic search).** New **`/codebase`** command answers
  questions about your whole project: it indexes your workspace into embeddings
  and retrieves the most relevant code as context. Enable `localai.rag.enabled`,
  run **CvSU-AI VSCode Chat: Index Workspace for RAG**, then ask `/codebase how does auth
  work?`. A status-bar item shows index state. Uses a dedicated `nomic-embed-text`
  embedding model on the local server. Commands: Index, Show Stats, Clear Index.
- **Fixed the agent's "file not found" loop on test creation.** Two causes:
  (1) it guessed/truncated paths — now agent mode is handed the **exact** source
  dir + conventional test path so it never guesses; (2) in multi-root workspaces,
  new files resolved to the wrong folder — `write_file` now creates the file in
  the folder that actually contains its target directory.

## 0.11.1
- **Code blocks now wrap** instead of overflowing with a cut-off horizontal
  scrollbar — long lines stay readable in the narrow panel. A **⤶ Wrap** toggle
  on each block switches back to horizontal scroll when you prefer it.
- **Syntax highlighting** for code blocks (keywords, strings, numbers, comments)
  — dependency-free and themed to your VS Code colors.
- **Fixed the reply footer** (tokens · tok/s · Regenerate/Continue): it now sits
  on its own clean line under the message instead of cramping beside the code.
- The **✎ edit** button no longer pushes message layout around.

## 0.11.0
- **Regenerate & Edit-and-resend.** Each reply now has a **↻ Regenerate** button;
  every message you sent has a **✎** to edit and resend it.
- **Continue.** When a reply is cut off (e.g. by `maxTokens`), click **→ Continue**
  to keep going from where it stopped.
- **Speed indicator.** A small footer under each reply shows approx tokens, **tok/s**,
  and time-to-first-token — so you can see the local-vs-server difference live.
- **`@file` mentions.** Type `@` in the composer to pick a workspace file; its
  contents are attached to your message precisely (📎 chip shows the count).
- **Fast 3B model** (`gpt-3.5-turbo`) available on the local instance —
  ~110 tok/s for quick asks. Pick it via **CvSU-AI VSCode Chat: List Models**. (Switching
  models reloads VRAM, so the first call after a switch is slower.)

## 0.10.1
- **Fixed agent mode dumping raw tool-call JSON into the chat.** Local models
  often emit a tool call as plain JSON in the message text; that JSON is now
  detected mid-stream and **hidden** from the chat (it's executed as a real tool
  call instead). Prose and code blocks still stream normally.
- **Fixed the agent looping on the same file lookup.** Path resolution now
  handles **absolute paths** and **multi-root workspaces** (it finds the file in
  whichever open folder contains it), and recovers from "doubled" paths like
  `apps/c:/Users/...`. `read_file` now returns a clear "use list_files" hint
  instead of a bare error.
- **Loop guard:** if the agent repeats the same failing tool call, it gets one
  corrective nudge, then stops cleanly with an explanation — no more spinning to
  the iteration cap.

## 0.10.0
- **Server / Local toggle in the UI.** A new chip in the chat header (and a
  status-bar item) shows whether you're using the shared server
  (`localhost:8081`) or a local LocalAI instance (`http://127.0.0.1:8088`), and
  switches between them in one click.
- **Auto-disables Local when it's offline:** the toggle health-checks the local
  instance (`/readyz`). If nothing's running there, switching *to* Local is
  disabled; if you're *on* Local and it goes down, the chip turns red ("Local
  (down)") so you know requests will fail — and you can still switch back.
- New command **CvSU-AI VSCode Chat: Switch Server / Local**.

## 0.9.3
- New **`localai.maxTokens`** setting caps the model's reply length. Generation
  time scales with reply length, so a smaller cap = a faster reply (0 = no cap).
  Sent on every request (chat, agent, streaming). Try `400`–`600` for snappier
  answers on the current server.
- Documented the measured server bottleneck (~2.4 tok/s, ~12s to first token =
  CPU-bound 7B model) and the GPU/quant fix in `ADMIN-REQUEST.md`. The real
  speed fix is server-side; client settings only trim length, not per-token cost.

## 0.9.2
- Fixed the **history panel staying open / blocking the chat**: a `display:flex`
  rule was overriding the `hidden` attribute, so the panel never actually closed.
  It's now hidden by default and only opens via the History button.

## 0.9.1
- Fixed the **chat history panel showing blank**: the host sent the session list
  before the webview was listening. Added a ready handshake so restore + history
  load reliably on open.
- Rename now uses a native input box (webviews block `window.prompt`).

## 0.9.0
- Two new slash commands: **`/caveman`** (answer ultra-tersely, full accuracy)
  and **`/ponytail`** (solve with the least code via a YAGNI→reuse→stdlib→native
  ladder, never cutting safety). Inspired by the caveman & ponytail Claude skills.

## 0.8.1
- Agent tools (`list_files`, `search`) and context now **exclude noise** —
  `.playwright-mcp`, `.git`, `__pycache__`, `dist`/`build`, venvs, logs, caches —
  so the model sees real source files, not artifacts.
- Redesigned the **chat history** panel: full-height slide-over, cleaner list,
  friendlier empty state.

## 0.8.0
- **Session history:** conversations are saved (globalState) and **persist across
  reloads and restarts**. A **History** panel in the chat header lists past chats
  — click to reopen, rename, or delete. **＋ New** starts a fresh chat. The most
  recent chat is restored when you open the panel.

## 0.7.0
- **Slash commands:** type `/` for a command menu — `/explain`, `/test`, `/fix`,
  `/review`, `/doc`, `/refactor`, `/ask`. Each expands into an engineered prompt
  using your selection/open file; file-editing commands auto-run in agent mode.

## 0.6.1
- Docs point at the repository; build pinned to Node 24.

## 0.6.0
- **Read-before-write:** the agent no longer blindly overwrites existing files.
  `write_file` is overwrite-guarded (rejects an existing file unless the model
  reads it and passes `overwrite:true`).
- New **`append_to_file`** tool so the agent ADDS to an existing test file
  instead of replacing it.
- Context now flags when a test file already exists for the open file, so the
  agent appends to it.

## 0.5.0
- Add deterministic **Apply** and **Copy** buttons on every code block (write a
  block to a file you pick, with overwrite/append handling) — independent of the model.

## 0.4.0
- Agent mode now **writes files directly** via `write_file` (stronger prompt;
  written files open automatically).

## 0.3.x
- Context-aware chat: attaches the **selection → open file → workspace** automatically.
- Fixed wrong-file detection (ignores Output panel / non-file editors).
- Token-budget the context and trim history so requests fit the server's window.

## 0.2.x
- Official LocalAI logo in the chat header and empty state.
- Renamed to **CvSU-AI VSCode Chat**; production packaging (publisher, icon, LICENSE).

## 0.1.0
- Copilot-style webview chat with streaming, agent mode, and workspace tools.
- Session-cookie / API-key auth via SecretStorage; Sign In flow.
