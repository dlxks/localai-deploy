# CvSUAI

A Copilot/Claude-style AI chat panel and coding agent for your own **LocalAI** server.

This repository is a fork of the original project and is still under active improvements.

- **Chat** — streaming responses in a clean side panel.
- **Context-aware** — automatically uses your selection → open file → workspace.
- **Agent mode** — the assistant can read, search, and edit files in your open
  workspace (file writes require confirmation).
- **Apply buttons** — every code block has **Apply** (write it to a file) and **Copy**.
- **Two ways to sign in** — paste an API key, or sign in via GitHub in the browser.

---

## Quick start (TL;DR)

1. **Build and Install** the `.vsix` file (see below) and **reload** your IDE.
2. Click the **CvSUAI icon** in the Activity Bar (left strip).
3. **Configure** — Click the ⚙️ Settings icon at the top of the chat panel to easily set your Model, Base URLs, and API key.
4. **Ask anything.** Open a file and type — it auto-attaches the file/selection as context.
5. **Want it to edit files?** Tick **Agent mode**, or type **`/fix`**, **`/test`**, **`/refactor`**.

### IDE compatibility
- Works in **VS Code** and most **VS Code-derived IDEs** that support standard VSIX extensions.
- This includes **Antigravity IDE** and other forks that keep VS Code extension APIs.
- Best compatibility path is **Install from VSIX** in the IDE's Extensions panel.
- If a forked IDE uses OpenVSX, install from OpenVSX or install the same `.vsix` manually.

---

## Install

To install the extension from source:

1. Clone this repository and run `npm install`.
2. Build the extension package: `npm run package`.
3. Install the generated `.vsix` file:
  - **Any compatible IDE UI (VS Code, Antigravity, forks):** Extensions panel → `…` (top-right) → **Install from VSIX…** → pick the file.
  - **or CLI:** `code --install-extension localai-vscode-chat-<version>.vsix`
4. Reload your IDE.

Notes for non-VS Code IDEs:
- Some forks use a different CLI binary name than `code`.
- If the CLI command fails, use the IDE UI "Install from VSIX" flow.

### Troubleshooting (Antigravity / VS Code forks)

If you see errors like `command 'cvsuai.openSettings' not found` or
`command 'cvsuai.newChat' not found`:

1. Uninstall the old version of the extension.
2. Install the latest generated `.vsix` again using **Install from VSIX**.
3. Reload the IDE window.
4. Open **Output** → choose **Log (Extension Host)** and check for activation errors.

Why this happens:
- Some forks implement only part of the VS Code API. The extension now falls back
  safely when optional APIs are missing, so core commands can still register.

### Configuration

The easiest way to configure the extension is to use the **Settings Button (⚙️)** located at the top-right of the chat panel. Clicking this button lets you:
- **Set Server URL:** Configure the URL for the CvSU AI Server.
- **Set Server API Key:** Prompts you to paste your API Key specifically for the CvSU AI Server.
- **Set Local URL:** Configure the URL for your Local AI Server.
- **Set LocalDeploy API Key:** Prompts you to paste your API Key specifically for your local deployment.
- **Set Chat Model:** Dynamically fetches available models from your active server and lets you pick the main chat model from a dropdown list.
- **Set Agent Model:** Dynamically fetches available models and lets you pick a heavy, capable model strictly for Agent execution (tools/file edits).
- **Set Embedding Model:** Dynamically fetches available models and lets you pick your RAG embedding model from a dropdown list.
- **Set Autocomplete Model:** Dynamically fetches available models and lets you pick your fast model for inline autocomplete ghost-text.
- **Advanced Settings:** Opens VS Code Settings directly to the extension's config page where you can edit other parameters.

---

## How to use it

### Keyboard shortcut
- Open chat shortcut defaults to **Ctrl+Shift+L** on Windows/Linux and **Cmd+Shift+L** on macOS.
- You can change it anytime from Command Palette via **CvSU-AI VSCode Chat: Edit Keyboard Shortcut**.
- Then search for **cvsuai.openChat** in keybindings to assign your preferred key combo.

### Plain chat
Open the panel and type. The reply streams in. The extension **automatically
attaches context**: your current selection if you have one, otherwise the open
file, otherwise a workspace file listing. A small 📎 chip shows what was attached.

- **Ask about the open file:** just open it and ask, e.g. *"explain the validate method."*
- **Ask about specific code:** select it first, then ask — the selection is sent precisely.

### Apply / Copy code
Every code block the assistant returns has an **Apply** and a **Copy** button.
- **Apply** prompts for a file path (pre-filled with a smart default) and writes
  the code there, opening it in the editor. If the file exists, you choose
  **Overwrite** or **Append**. This works regardless of the model.
- **Copy** copies the block to your clipboard.

### Inline Autocomplete
The extension supports GitHub Copilot-style inline ghost-text autocomplete. As you type in the editor, the extension will silently ping your fast model in the background and suggest code completions that you can accept by pressing `Tab`.
To enable it via the UI:
1. Click the **⚙️ Settings** button and select **Set Autocomplete Model** to choose your fastest/smallest model (e.g. `lfm2.b-1.2b-instruct`).
2. Open **Advanced Settings** and enable the `localai.autocomplete.enabled` checkbox.

Alternatively, you can configure it directly in your `settings.json`:
```json
"localai.autocomplete.enabled": true,
"localai.autocomplete.model": "your-preferred-fast-model-name"
```

### Slash commands
Type `/` in the composer to open a command menu (↑/↓ to choose, Enter to pick).
Each wraps your selection / open file in a good prompt:

| Command | Does |
|---|---|
| `/explain` | Explain the selected code or open file |
| `/test` | Write unit tests (appends to an existing test file) |
| `/fix` | Find and fix bugs |
| `/review` | Code review with concrete findings |
| `/doc` | Add docstrings / comments |
| `/refactor` | Refactor for clarity without changing behavior |
| `/ask` | Free-form question about the code |
| `/caveman` | Answer ultra-tersely — few words, full accuracy ([caveman](https://github.com/JuliusBrussee/caveman)) |
| `/ponytail` | Solve with the least code, never cutting safety ([ponytail](https://github.com/DietrichGebert/ponytail)) |

You can add detail after the command, e.g. `/fix handle the null case`.
Commands that edit files (`/test`, `/fix`, `/doc`, `/refactor`) run in agent mode
automatically.

### Custom agents, skills & project instructions
Tailor the assistant per project with a **`.cvsuai/`** folder (run **CvSU-AI VSCode Chat:
Set Up Custom Agents & Skills** to create it with examples):

```
.cvsuai/
  instructions.md      # prepended to every message (project rules, like CLAUDE.md)
  skills/commit-msg.md # a /commit-msg command — a prompt template ($ARGUMENTS = your text)
  agents/reviewer.md   # a /reviewer agent — runs in agent mode with your system prompt
```

Each skill/agent file has optional frontmatter (`description:` shows in the `/`
menu) and a body. **Skills** are read-only prompt templates; **agents** can read
and edit files. Edits are picked up live. Your `/commands` appear right alongside
the built-in ones.

### Codebase search (RAG)
Ask about your whole project, not just the open file:
1. Set **`localai.rag.enabled`** to true.
2. Run **CvSU-AI VSCode Chat: Index Workspace for RAG** (one-time; re-run after big changes).
3. Ask with **`/codebase`**, e.g. `/codebase where is the DV approval logic?`

It embeds your code and retrieves the most relevant chunks as context. The
status-bar **$(book) RAG** item shows index state. Requires a `nomic-embed-text`
embedding model on the local server (see `../local-localai/`). Other commands:
**Show RAG Index Stats**, **Clear RAG Index**.

### Reply actions, @files, and speed
- Under each reply: **↻ Regenerate** (redo), **→ Continue** (extend a cut-off
  reply), and a footer showing approx **tokens · tok/s · time-to-first-token**.
- On your messages: **✎** to edit and resend.
- Type **`@`** in the composer to attach a specific workspace file to your
  message (a 📎 chip shows how many files were attached).
- Enable **Autopilot** in the composer to auto-recover interrupted replies:
  it compacts older history when needed, then issues a Continue automatically.

### Server / Local toggle
A chip in the chat header (and a status-bar item) shows which AI you're talking to:
- **☁ Server** — the shared LocalAI server (`localhost:8081`).
- **💻 Local** — a LocalAI instance on your own machine (`http://127.0.0.1:8088`),
  much faster if you have the GPU for it (see `../local-localai/`).

Click it to switch; reload the window when prompted. The toggle **health-checks
the local instance**: if it isn't running, switching *to* Local is disabled. If
you're on Local and it stops responding, the chip turns red (**⚠ Local (down)**)
and you can switch back to the server. Also available as the command
**CvSU-AI VSCode Chat: Switch Server / Local**.

### Chat history
Conversations are saved automatically and **survive reloads/restarts**. Long
chats **auto-compact**: when you approach the model's context window, older
messages are summarized into a compact summary and the chat keeps going (recent
messages stay verbatim) — no interruption, no lost context. Toggle with
`localai.autoCompact`; compact manually anytime via **CvSU-AI VSCode Chat: Compact Chat**.

Use the header buttons:
- **History** — opens a list of past chats; click one to reopen it, or use ✎ to
  rename / 🗑 to delete.
- **＋ New** — start a fresh conversation.

History is stored globally (visible across all your projects).

### Agent mode
Tick **Agent mode** in the composer to let the assistant *act* on your workspace.
It runs a loop — read/search files, then create or edit them — and asks for
approval before any file write. Example: *"add a unit test for this method."*
It reads an existing test file and **appends** rather than overwriting it.

---


## Commands

| Command | Description |
|---|---|
| **CvSU-AI VSCode Chat: Open Chat** | Open the chat panel. |
| **CvSU-AI VSCode Chat: Chat with Selection** | Send the editor selection to chat. |
| **CvSU-AI VSCode Chat: Sign In** | Choose API key or GitHub login. |
| **CvSU-AI VSCode Chat: Sign Out** | Clear stored credentials. |
| **CvSU-AI VSCode Chat: List Models** | List server models and set the default. |
| **CvSU-AI VSCode Chat: New Chat** | Start a fresh conversation. |
| **CvSU-AI VSCode Chat: Compact Chat** | Summarize older messages on demand to free context. |
| **CvSU-AI VSCode Chat: Switch Server / Local** | Toggle between the shared server and your local GPU. |
| **CvSU-AI VSCode Chat: Set Up Custom Agents & Skills** | Scaffold a `.cvsuai/` folder. |
| **CvSU-AI VSCode Chat: Index Workspace for RAG** | Build the `/codebase` semantic index. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `localai.baseUrl` | `http://ai.cvsu.edu.ph` | Current Base URL; `/v1` is appended. |
| `localai.serverUrl` | `http://ai.cvsu.edu.ph` | Server URL when you toggle to Server mode. |
| `localai.localUrl` | `http://localhost:8081` | Local URL when you toggle to Local mode. |
| `localai.model` | `qwen2.5-...` | Chat model. |
| `localai.contextSize` | `4096` | The model's context window in tokens. **Must match the loaded model** — set to `8192` for the local instance. Drives history trimming and auto-compaction. |
| `localai.autoCompact` | `true` | Auto-summarize older messages when a chat nears the window (keeps context, frees tokens). Off = a simple warning instead. |
| `localai.autopilot` | `false` | If a reply is interrupted/stopped, auto-compact old context (if needed) then auto-continue. |
| `localai.maxTokens` | `0` | Cap the reply length (0 = no cap). Lower = faster replies. Try `400`–`600`. |
| `localai.contextTokenBudget` | `2500` | Max tokens of context attached per message. Lower = smaller, faster requests. |
| `localai.agent.maxIterations` | `8` | Max agent tool-call steps per turn. |
| `localai.agent.autoApproveWrites` | `false` | Skip the file-write confirmation. |
| `localai.agent.model` | `""` | The agent-specific execution model (empty = falls back to main chat model). |
| `localai.autocomplete.enabled` | `false` | Enable inline autocomplete (ghost-text). |
| `localai.autocomplete.model` | `lfm2.b-1.2b-instruct` | Model used for inline autocomplete. |

> **Slow responses?** The server runs a 7B model at ~2.4 tokens/sec, so long
> replies take minutes. Set `localai.maxTokens` to `400`–`600`, drop
> `localai.contextTokenBudget` to ~`1000`, and prefer plain chat over Agent mode
> for quick asks. The real fix is server-side (GPU) — see `ADMIN-REQUEST.md`.

Note: there is intentionally **no** `apiKey` setting — keys live in SecretStorage
(via Sign In) so they're never written to a synced `settings.json`.

---

## Agent mode tools

| Tool | Access | Notes |
|---|---|---|
| `read_file` | read-only | Read a workspace file. |
| `list_files` | read-only | List workspace files (excludes node_modules). |
| `search` | read-only | Substring search across file contents. |
| `write_file` | **mutating** | Create a file. Overwrite-guarded: replacing an existing file requires reading it first. **Confirmation required.** |
| `append_to_file` | **mutating** | Add to the end of an existing file (e.g. a new test) without rewriting it. **Confirmation required.** |

Read-only tools run automatically; writes prompt (Allow / Allow-for-session).
The agent operates on the **first folder open** in the VS Code window, so open
your project folder to use it.

---

## For maintainers — build & package

```bash
npm install
npm run compile          # typecheck (tsc --noEmit)
npm run build            # bundle to dist/extension.js
npm run package          # produce localai-vscode-chat-<version>.vsix (via @vscode/vsce)
```

Press **F5** to run in the Extension Development Host.

**Dev credentials:** create a `.env` in the extension root (see `.env.example`).
It's loaded **only** in the Dev Host and is excluded from git and the `.vsix`, so
your personal key never ships. Verify a package before sharing:

```bash
npx @vscode/vsce ls      # list files that will be in the .vsix — confirm no .env
```

### Code layout

- `src/client.ts` — API client (fetch + SSE), credential resolution, auth headers.
- `src/auth.ts` — Sign In/Out flows (API key + browser GitHub login).
- `src/env.ts` — dev-only `.env` loader (Development mode + extension root).
- `src/agent.ts` — agent loop (streamed model → tools → results → repeat).
- `src/tools.ts` — workspace tools with read-only/mutating tags.
- `src/chatPanel.ts` — webview chat panel and message bridge.
- `media/chat.{css,js}` — chat front-end.
