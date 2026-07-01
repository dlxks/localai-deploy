import * as vscode from "vscode";
import { ChatMessage, streamChat, hasCredentials, getModel, listModels, summarize, SUMMARY_MAX_TOKENS } from "./client";
import { runAgent } from "./agent";
import { ToolContext, EXCLUDE_GLOB, resolveExisting } from "./tools";
import { ensureCredentials, signIn } from "./auth";
import { gatherContext } from "./context";
import { parseSlash, allSlashCommands } from "./slashCommands";
import { getCustomConfig } from "./customConfig";
import { SessionStore, Session, titleFrom, stamp, newId } from "./sessionStore";
import { currentTarget, isLocalReachable } from "./endpoints";
import { RagService } from "./ragService";

/**
 * The chat as a native Activity Bar sidebar view (like Copilot/Claude).
 * Implemented as a WebviewViewProvider so VS Code persists it and AUTO-REOPENS
 * it on reload. Registered once in extension.ts against the "cvsuai.chatView" id.
 */
export class ChatPanel implements vscode.WebviewViewProvider {
  /** The single provider instance (registered in extension.ts). */
  public static current: ChatPanel | undefined;
  /** Shared RAG service, injected from extension.ts at activation. */
  public static rag: RagService | undefined;
  public static readonly viewId = "cvsuai.chatView";

  private view: vscode.WebviewView | undefined;
  private readonly extensionUri: vscode.Uri;
  private readonly secrets: vscode.SecretStorage;
  private readonly store: SessionStore;
  private readonly disposables: vscode.Disposable[] = [];

  private history: ChatMessage[] = [];
  private sessionId = newId();
  private createdAt = stamp();
  private abort: AbortController | undefined;
  private agentMode = false;
  /** True once the user picks "Allow for this session" on a write. */
  private approveAllWrites = false;
  /** True once we've shown the "chat getting long" notice for this conversation. */
  private warnedNearLimit = false;

  constructor(context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;
    this.secrets = context.secrets;
    this.store = new SessionStore(context.globalState);
    ChatPanel.current = this;
  }

  /** Reveal the chat view (focus the sidebar). */
  static show(_context?: vscode.ExtensionContext) {
    void vscode.commands.executeCommand(`${ChatPanel.viewId}.focus`);
  }

  /** VS Code calls this when the view becomes visible (incl. on reload). */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    view.onDidDispose(() => (this.view = undefined), null, this.disposables);
  }

  public refreshUI() {
    void this.postTargetState();
    void this.postAuthState();
    this.postModelState();
    this.postAutoApproveWritesState();
    this.postAutopilotState();
    this.refreshSlashMenu();
  }

  /** Called when the webview's JS has loaded and can receive messages. */
  private onWebviewReady() {
    void this.postAuthState();
    this.postAutoApproveWritesState();
    this.postAutopilotState();
    const recent = this.store.mostRecent();
    if (recent && recent.messages.length > 0) {
      this.loadSession(recent.id);
    } else {
      this.postSessionList();
    }
  }

  /** Seed the input with selected text by sending it as the first message.
   *  Waits briefly for the view to resolve if it was just opened. */
  async sendInitial(text: string) {
    for (let i = 0; i < 20 && !this.view; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.view?.webview.postMessage({ type: "clear" });
    this.history = [];
    await this.handleUserMessage(text, /*echoToUi*/ true);
  }

  private async onMessage(msg: any) {
    switch (msg.type) {
      case "ready":
        this.onWebviewReady();
        void this.postTargetState();
        this.postModelState();
        this.refreshSlashMenu();
        break;
      case "requestAutoApproveWrites":
        this.postAutoApproveWritesState();
        break;
      case "requestAutopilotMode":
        this.postAutopilotState();
        break;
      case "toggleTarget":
        await vscode.commands.executeCommand("cvsuai.toggleTarget");
        this.refreshUI();
        break;
      case "switchModel":
        await this.switchModel();
        break;
      case "setModel":
        await this.setModel(String(msg.model ?? ""));
        break;
      case "refresh":
        this.refreshUI();
        break;
      case "refreshTarget":
        void this.postTargetState();
        break;
      case "signIn":
        await signIn(this.secrets);
        void this.postAuthState();
        break;
      case "send":
        await this.handleUserMessage(msg.text, /*echoToUi*/ false);
        break;
      case "regenerate":
        await this.regenerate();
        break;
      case "continue":
        await this.continueReply();
        break;
      case "editResend":
        await this.editResend(String(msg.text ?? ""));
        break;
      case "fileQuery":
        await this.postFileMatches(String(msg.query ?? ""));
        break;
      case "stop":
        this.abort?.abort();
        break;
      case "clearRequest":
      case "newSession":
        this.startNewSession();
        break;
      case "setAgentMode":
        this.agentMode = Boolean(msg.value);
        break;
      case "setAutoApproveWrites":
        await vscode.workspace.getConfiguration("localai").update(
          "agent.autoApproveWrites",
          Boolean(msg.value),
          vscode.ConfigurationTarget.Global
        );
        break;
      case "setAutopilotMode":
        await vscode.workspace.getConfiguration("localai").update(
          "autopilot",
          Boolean(msg.value),
          vscode.ConfigurationTarget.Global
        );
        break;
      case "applyCode":
        await this.applyCode(String(msg.code ?? ""), String(msg.lang ?? ""));
        break;
      case "listSessions":
        this.postSessionList();
        break;
      case "loadSession":
        this.loadSession(String(msg.id ?? ""));
        break;
      case "renameSession":
        await this.store.rename(String(msg.id ?? ""), String(msg.title ?? ""));
        this.postSessionList();
        break;
      case "renameSessionPrompt":
        await this.renameSessionPrompt(String(msg.id ?? ""));
        break;
      case "deleteSession":
        await this.deleteSession(String(msg.id ?? ""));
        break;
    }
  }

  private async renameSessionPrompt(id: string) {
    const current = this.store.get(id);
    const title = await vscode.window.showInputBox({
      prompt: "Rename chat",
      value: current?.title ?? "",
      ignoreFocusOut: true,
    });
    if (title && title.trim()) {
      await this.store.rename(id, title.trim());
      this.postSessionList();
    }
  }

  // ---- session management ----

  private postSessionList() {
    this.view?.webview.postMessage({
      type: "sessionList",
      sessions: this.store.list(),
      currentId: this.sessionId,
    });
  }

  /** Build a small per-reply stats object for the UI footer (approx tokens,
   *  tokens/sec, and time-to-first-token). Tokens are estimated at ~4 chars
   *  each — consistent with the rest of the extension's budgeting. */
  private makeStats(text: string, started: number, firstTokenAt: number) {
    const now = Date.now();
    const approxTokens = Math.max(1, Math.round(text.length / 4));
    const genMs = firstTokenAt ? now - firstTokenAt : now - started;
    const tps = genMs > 0 ? (approxTokens / (genMs / 1000)) : 0;
    return {
      tokens: approxTokens,
      tps: Math.round(tps * 10) / 10,
      ttftMs: firstTokenAt ? firstTokenAt - started : 0,
      model: getModel(),
    };
  }

  /** Return up to ~20 workspace files matching the @-mention query substring. */
  private async postFileMatches(query: string) {
    const q = query.toLowerCase();
    let uris = await vscode.workspace.findFiles("**/*", EXCLUDE_GLOB, 2000);
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.path);
    const rel = (p: string) => {
      for (const r of roots) {
        if (p.startsWith(r + "/")) return p.slice(r.length + 1);
      }
      return p;
    };
    const matches = uris
      .map((u) => rel(u.path))
      .filter((p) => !q || p.toLowerCase().includes(q))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, 20);
    this.view?.webview.postMessage({ type: "fileMatches", files: matches });
  }

  /**
   * Resolve @path mentions in the user's text into attached file context.
   * Returns the cleaned text (mentions removed) and a context block of contents.
   */
  private async resolveMentions(text: string): Promise<{ text: string; attached: string }> {
    const mentionRe = /(^|\s)@([^\s]+)/g;
    const paths: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = mentionRe.exec(text)) !== null) paths.push(m[2]);
    if (paths.length === 0) return { text, attached: "" };

    const blocks: string[] = [];
    for (const p of paths) {
      try {
        const uri = await resolveExisting(p);
        const bytes = await vscode.workspace.fs.readFile(uri);
        let content = Buffer.from(bytes).toString("utf8");
        if (content.length > 8000) content = content.slice(0, 8000) + "\n…[truncated]";
        blocks.push(`File: ${p}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        blocks.push(`File: ${p}\n(could not read — not found)`);
      }
    }
    // Strip the @mentions from the visible prompt (keep surrounding spacing).
    const cleaned = text.replace(/(^|\s)@[^\s]+/g, "$1").replace(/\s{2,}/g, " ").trim();
    return { text: cleaned || text, attached: blocks.join("\n\n") };
  }

  /** Tell the webview which target is active and whether local is reachable,
   *  so the header chip shows the right label and disables Local when down. */
  private async postTargetState() {
    const target = currentTarget();
    const localUp = await isLocalReachable();
    this.view?.webview.postMessage({ type: "target", target, localUp });
  }

  private async postAuthState() {
    const authed = await hasCredentials(this.secrets);
    this.view?.webview.postMessage({ type: "authState", authed });
  }

  private postAutoApproveWritesState() {
    const enabled = vscode.workspace.getConfiguration("localai").get<boolean>("agent.autoApproveWrites") ?? false;
    this.view?.webview.postMessage({ type: "autoApproveWrites", value: enabled });
  }

  private postAutopilotState() {
    const enabled = vscode.workspace.getConfiguration("localai").get<boolean>("autopilot") ?? false;
    this.view?.webview.postMessage({ type: "autopilotMode", value: enabled });
  }

  private autopilotEnabled(): boolean {
    return vscode.workspace.getConfiguration("localai").get<boolean>("autopilot") ?? false;
  }

  /** Tell the webview the currently-selected model (for the header chip). */
  /** Push current model immediately, then async-fetch the available list for the
   *  dropdown (so the select shows the current value without waiting on the server). */
  private postModelState() {
    const current = getModel();
    this.view?.webview.postMessage({ type: "model", model: current });
    void this.postModelList(current);
  }

  /** Fetch the server's available models and send them to populate the dropdown. */
  private async postModelList(current: string) {
    let models: string[] = [];
    try {
      models = await listModels(this.secrets);
    } catch {
      models = []; // offline / not signed in — the select still shows the current value
    }
    if (current && !models.includes(current)) models = [current, ...models];
    this.view?.webview.postMessage({ type: "models", models, current });
  }

  /** Set the active model from the dropdown selection. */
  private async setModel(model: string) {
    if (!model) return;
    await vscode.workspace.getConfiguration("localai")
      .update("model", model, vscode.ConfigurationTarget.Global);
    this.view?.webview.postMessage({ type: "model", model });
  }

  /** Push the current (built-in + custom) slash command list to the webview menu. */
  public refreshSlashMenu() {
    this.view?.webview.postMessage({
      type: "slashCommands",
      commands: allSlashCommands().map((c) => ({ name: c.name, description: c.description })),
    });
  }

  /** Command-palette entry: pick a model via native QuickPick (kept as an alternative). */
  private async switchModel() {
    try {
      const ids = await listModels(this.secrets);
      if (ids.length === 0) {
        vscode.window.showInformationMessage("CvSU-AI VSCode Chat: no models available on this server.");
        return;
      }
      const current = getModel();
      const pick = await vscode.window.showQuickPick(
        ids.map((id) => ({ label: id, description: id === current ? "current" : "" })),
        { placeHolder: `Select a model (current: ${current})` }
      );
      if (pick) {
        await this.setModel(pick.label);
        void this.postModelList(pick.label);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`CvSU-AI VSCode Chat: ${err?.message ?? String(err)}`);
    }
  }

  /** Save the current conversation to the store (skips empty chats). */
  private async saveCurrent() {
    if (this.history.length === 0) return;
    const session: Session = {
      id: this.sessionId,
      title: titleFrom(this.history),
      messages: this.history,
      createdAt: this.createdAt,
      updatedAt: stamp(),
    };
    await this.store.upsert(session);
  }

  /** Public entry for the "New Chat" title-bar button / command. */
  public newChatFromCommand() {
    this.startNewSession();
  }

  private startNewSession() {
    this.history = [];
    this.sessionId = newId();
    this.createdAt = stamp();
    this.approveAllWrites = false;
    this.warnedNearLimit = false;
    this.compactFailed = false;
    this.view?.webview.postMessage({ type: "clear" });
    this.postSessionList();
  }

  private loadSession(id: string) {
    this.postAutoApproveWritesState();
    this.postAutopilotState();
    const s = this.store.get(id);
    if (!s) return;
    this.history = s.messages.slice();
    this.sessionId = s.id;
    this.createdAt = s.createdAt;
    this.approveAllWrites = false;
    this.warnedNearLimit = false;
    this.compactFailed = false;
    // Render the saved conversation in the webview.
    this.view?.webview.postMessage({
      type: "loadConversation",
      messages: s.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content })),
    });
    this.postSessionList();
  }

  private async deleteSession(id: string) {
    await this.store.delete(id);
    if (id === this.sessionId) {
      this.startNewSession();
    } else {
      this.postSessionList();
    }
  }

  private async handleUserMessage(text: string, echoToUi: boolean) {
    if (echoToUi) {
      // Webview wasn't the source; ask it to render the user bubble + start streaming.
      this.view?.webview.postMessage({ type: "renderUser", text });
    }

    if (!(await hasCredentials(this.secrets))) {
      this.view?.webview.postMessage({ type: "done" });
      const ok = await ensureCredentials(this.secrets);
      if (!ok) {
        this.view?.webview.postMessage({
          type: "error",
          value: "Not signed in. Click the LocalAI status-bar item or run “CvSU-AI VSCode Chat: Sign In”.",
        });
        return;
      }
    }

    // Expand a /slash command into a full prompt. The user still SEES what they
    // typed; the model receives the engineered prompt.
    const slash = parseSlash(text);
    // Resolve any @file mentions into attached file contents.
    const mentioned = await this.resolveMentions(slash ? slash.prompt : text);
    const promptForModel = mentioned.text;
    // Agent decision:
    //  - A slash command's own preference WINS (e.g. /explain is read-only and
    //    works on the already-attached code, so it never tool-loops even if the
    //    Agent-mode box is ticked; /fix always uses the agent to write files).
    //  - Free-form messages follow the Agent-mode checkbox.
    const useAgent = slash ? slash.prefersAgent : this.agentMode;

    // Gather editor/workspace context for this turn (selection > file > workspace).
    const ctx = await gatherContext(useAgent);
    const mentionCount = (text.match(/(^|\s)@[^\s]+/g) ?? []).length;
    const chip = [
      slash ? `/${slash.command}` : "",
      mentionCount ? `📎 ${mentionCount} file${mentionCount > 1 ? "s" : ""}` : "",
      mentionCount ? "" : ctx.label, // explicit @files take precedence over auto-context
    ]
      .filter(Boolean)
      .join(" · ");
    if (chip) {
      this.view?.webview.postMessage({ type: "context", label: chip });
    }

    // If the user @-mentioned files, prepend their contents as system context.
    let turnContext = mentioned.attached
      ? `The user attached these files:\n\n${mentioned.attached}\n\n${ctx.systemText}`
      : ctx.systemText;

    // Project-level custom instructions (.cvsuai/instructions.md) apply to every
    // turn; a custom agent's own system prompt applies when its /command is used.
    const cfg = getCustomConfig();
    const extraSystem = [
      cfg.instructions ? `Project instructions:\n${cfg.instructions}` : "",
      slash?.systemPrompt ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");

    // /codebase: augment with semantically-retrieved chunks (RAG).
    if (slash?.command === "codebase") {
      const rag = ChatPanel.rag;
      if (!rag || !rag.ready) {
        this.view?.webview.postMessage({
          type: "context",
          label: "⚠ no index — run “CvSU-AI VSCode Chat: Index Workspace for RAG”",
        });
      } else {
        const topK = vscode.workspace.getConfiguration("localai").get<number>("rag.topK") ?? 5;
        const retrieved = await rag.retrieve(promptForModel, topK);
        if (retrieved) {
          turnContext = `${retrieved}\n\n${turnContext}`;
          this.view?.webview.postMessage({ type: "context", label: "🔎 codebase" });
        }
      }
    }

    this.history.push({ role: "user", content: promptForModel });
    const abort = new AbortController();
    this.abort = abort;

    if (useAgent) {
      await this.runAgentTurn(abort.signal, turnContext, extraSystem, ctx.openFile);
    } else {
      // Plain chat has no separate system slot for these, so fold them into context.
      const chatContext = extraSystem ? `${extraSystem}\n\n${turnContext}` : turnContext;
      await this.runChatTurn(abort.signal, chatContext);
    }

    // Persist after each completed turn (including the assistant reply) and
    // refresh the history list so the new/updated session shows up.
    await this.saveCurrent();
    this.postSessionList();

    // When the conversation nears the model's window, auto-compact it: summarize
    // the older turns and continue. Keeps context, frees tokens, no disruption.
    await this.maybeCompact();
  }

  /** Approx tokens used by the stored conversation (~4 chars/token). */
  private approxHistoryTokens(): number {
    const chars = this.history.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    return Math.ceil(chars / 4);
  }

  /** True while a compaction summary request is in flight (avoid re-entry). */
  private compacting = false;
  /** Set if auto-compaction failed this session, so we stop re-hammering the
   *  server with a doomed summarize call on every subsequent message (we fall
   *  back to the warning instead). A manual compact always retries. */
  private compactFailed = false;
  /** True while autopilot recovery (compact + continue) is running. */
  private autopilotRecovering = false;

  /**
   * If Autopilot is enabled, recover from interrupted output by compacting old
   * history first (to free tokens), then issuing a Continue.
   */
  private async maybeAutopilotRecover() {
    if (!this.autopilotEnabled() || this.autopilotRecovering) return;
    const last = this.history[this.history.length - 1];
    if (!last || last.role !== "assistant") return;

    this.autopilotRecovering = true;
    this.view?.webview.postMessage({ type: "status", value: "Autopilot: compacting then continuing…" });
    try {
      await this.compactNow(/*auto*/ true);
      await this.continueReply(/*fromAutopilot*/ true);
    } finally {
      this.autopilotRecovering = false;
      this.view?.webview.postMessage({ type: "status", value: "" });
    }
  }

  /** Trigger threshold helper: usable input budget in tokens. */
  private inputBudget(): number {
    const cfg = vscode.workspace.getConfiguration("localai");
    const ctxTokens = cfg.get<number>("contextSize") ?? 4096;
    const reply = cfg.get<number>("maxTokens") || 1024;
    return Math.max(1024, ctxTokens - reply);
  }

  /**
   * Auto-compaction: when the conversation nears the context window, summarize
   * the older turns into one compact summary and keep the most recent turns
   * verbatim. Preserves context, frees tokens, and doesn't disrupt the view.
   * Falls back to a one-time warning if auto-compact is disabled.
   */
  private async maybeCompact() {
    const cfg = vscode.workspace.getConfiguration("localai");
    if (this.compacting) return;
    if (this.approxHistoryTokens() < this.inputBudget() * 0.85) return;

    // Auto-compact disabled, or it already failed once this session: just warn
    // (don't keep firing a summarize call that's going to fail every turn).
    if (cfg.get<boolean>("autoCompact") === false || this.compactFailed) {
      this.maybeWarnNearLimit();
      return;
    }
    await this.compactNow(/*auto*/ true);
  }

  /**
   * Summarize all but the last few turns and replace them with one summary
   * message. `auto` controls the wording of the note.
   */
  public async compactNow(auto = false) {
    const KEEP_RECENT = 4; // keep ~2 recent exchanges verbatim
    if (this.compacting) return;
    // Need enough older messages for compaction to be worthwhile.
    if (this.history.length <= KEEP_RECENT + 1) {
      if (!auto) {
        vscode.window.showInformationMessage("CvSU-AI VSCode Chat: chat is already short — nothing to compact.");
      }
      return;
    }
    this.compacting = true;
    this.view?.webview.postMessage({ type: "status", value: "Compacting earlier messages…" });
    try {
      const recent = this.history.slice(-KEEP_RECENT);
      const older = this.history.slice(0, -KEEP_RECENT);
      let text = older
        .map((m) => `${m.role.toUpperCase()}: ${m.content ?? ""}`)
        .join("\n\n");

      // CRITICAL: summarize() bypasses trimming, so we must clip the input to fit
      // the model's context window — otherwise the summarize request itself is
      // rejected with "exceeds context size" (the bug that silently disabled
      // auto-compact on the default 4096-token window). Leave room for the
      // summary reply + the summarize prompt wrapper.
      const charCap = summaryInputCharCap();
      if (text.length > charCap) {
        // Keep the MOST RECENT of the older block (closest to the kept-recent
        // turns); note that the very earliest messages were dropped.
        text = "[earlier messages omitted]\n\n" + text.slice(text.length - charCap);
      }

      const summary = await summarize(this.secrets, text);
      if (!summary) throw new Error("empty summary");

      this.history = [
        { role: "system", content: `[Summary of earlier conversation]\n${summary}` },
        ...recent,
      ];
      this.warnedNearLimit = false;
      this.compactFailed = false;
      await this.saveCurrent();
      this.view?.webview.postMessage({ type: "status", value: "" });
      this.view?.webview.postMessage({
        type: "systemNote",
        text: auto
          ? "Earlier messages were auto-compacted into a summary to keep the chat going — recent messages and full context are preserved."
          : "Compacted earlier messages into a summary. Recent messages are kept as-is.",
      });
    } catch {
      this.view?.webview.postMessage({ type: "status", value: "" });
      // Don't break the chat — remember the failure (so auto-compact stops
      // retrying every turn) and fall back to the gentle warning.
      this.compactFailed = true;
      this.maybeWarnNearLimit();
    } finally {
      this.compacting = false;
    }
  }

  /**
   * Non-destructive heads-up when the conversation nears the context window.
   * Shown once per chat. Used as a fallback when auto-compact is off/failed.
   */
  private maybeWarnNearLimit() {
    if (this.warnedNearLimit) return;
    if (vscode.workspace.getConfiguration("localai").get<boolean>("warnNearContextLimit") === false) return;
    if (this.approxHistoryTokens() < this.inputBudget() * 0.85) return;

    this.warnedNearLimit = true;
    this.view?.webview.postMessage({
      type: "systemNote",
      text: "This chat is getting long — to stay within the model's limit, the oldest messages may not be sent. Click ＋ New for a fresh start with full context (this chat stays in History).",
    });
  }

  /** Index of the last user turn in history, or -1. */
  private lastUserIndex(): number {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "user") return i;
    }
    return -1;
  }

  /**
   * Re-run the last user message: drop everything from that user turn onward,
   * re-render the conversation, and send it again (gets a fresh reply).
   */
  private async regenerate() {
    const idx = this.lastUserIndex();
    if (idx < 0) return;
    const lastUser = this.history[idx].content;
    this.history = this.history.slice(0, idx); // remove the user turn + its reply
    this.rerenderConversation();
    await this.handleUserMessage(lastUser, /*echoToUi*/ true);
    await this.saveCurrent();
    this.postSessionList();
  }

  /** Replace the last user message with edited text and resend. */
  private async editResend(newText: string) {
    if (!newText.trim()) return;
    const idx = this.lastUserIndex();
    if (idx >= 0) this.history = this.history.slice(0, idx);
    this.rerenderConversation();
    await this.handleUserMessage(newText, /*echoToUi*/ true);
    await this.saveCurrent();
    this.postSessionList();
  }

  /**
   * Continue a reply that was likely cut off by max_tokens: append a short
   * "continue" instruction and stream more, joining it onto the last reply.
   */
  private async continueReply(fromAutopilot = false) {
    const last = this.history[this.history.length - 1];
    if (!last || last.role !== "assistant") return;
    const abort = new AbortController();
    this.abort = abort;
    // Stream into a fresh bubble; the user sees the continuation appended below.
    this.view?.webview.postMessage({ type: "stepStart" });

    // The "continue" instruction is TRANSIENT — sent to the model but never
    // stored in history. We merge the continuation into the previous assistant
    // message, so the saved conversation stays clean (no phantom "Continue…"
    // user bubble reappearing on reload).
    const messages: ChatMessage[] = [
      ...this.history,
      { role: "user", content: "Continue exactly where you left off. Do not repeat anything." },
    ];
    let assembled = "";
    const started = Date.now();
    let firstTokenAt = 0;
    try {
      await streamChat(
        this.secrets,
        messages,
        (delta) => {
          if (!firstTokenAt) firstTokenAt = Date.now();
          assembled += delta;
          this.view?.webview.postMessage({ type: "token", value: delta });
        },
        abort.signal
      );
      last.content = (last.content ?? "") + assembled;
      this.view?.webview.postMessage({ type: "done", stats: this.makeStats(assembled, started, firstTokenAt) });
    } catch (err: any) {
      if (this.abort?.signal.aborted) {
        if (assembled) last.content = (last.content ?? "") + assembled;
        this.view?.webview.postMessage({ type: "done", stats: this.makeStats(assembled, started, firstTokenAt) });
        if (!fromAutopilot) await this.maybeAutopilotRecover();
      } else {
        this.view?.webview.postMessage({ type: "error", value: err?.message ?? String(err) });
      }
    }
    await this.saveCurrent();
    this.postSessionList();
  }

  /** Re-paint the whole conversation in the webview from current history. */
  private rerenderConversation() {
    this.view?.webview.postMessage({
      type: "loadConversation",
      messages: this.history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content })),
    });
  }

  /** Plain streaming chat (no tools). */
  private async runChatTurn(signal: AbortSignal, contextText: string) {
    // Inject per-turn context as a transient system message (not stored in history).
    const messages: ChatMessage[] = contextText
      ? [{ role: "system", content: contextText }, ...this.history]
      : this.history;
    let assembled = "";
    const started = Date.now();
    let firstTokenAt = 0;
    try {
      await streamChat(
        this.secrets,
        messages,
        (delta) => {
          if (!firstTokenAt) firstTokenAt = Date.now();
          assembled += delta;
          this.view?.webview.postMessage({ type: "token", value: delta });
        },
        signal
      );
      this.history.push({ role: "assistant", content: assembled });
      this.view?.webview.postMessage({ type: "done", stats: this.makeStats(assembled, started, firstTokenAt) });
    } catch (err: any) {
      if (this.abort?.signal.aborted) {
        if (assembled) this.history.push({ role: "assistant", content: assembled });
        this.view?.webview.postMessage({ type: "done", stats: this.makeStats(assembled, started, firstTokenAt) });
        await this.maybeAutopilotRecover();
      } else {
        this.history.pop(); // roll back the user turn on failure
        this.view?.webview.postMessage({ type: "error", value: err?.message ?? String(err) });
      }
    }
  }

  /** Agentic turn: model may call workspace tools in a loop. */
  private async runAgentTurn(
    signal: AbortSignal,
    contextText: string,
    extraSystem = "",
    openFilePath?: string
  ) {
    const toolCtx: ToolContext = {
      confirm: (summary, detail) => this.confirmWrite(summary, detail),
      openFilePath,
    };
    const started = Date.now();
    let firstTokenAt = 0;
    let streamedChars = 0;
    try {
      await runAgent(
        this.secrets,
        this.history,
        {
          onStepStart: () => {
            this.view?.webview.postMessage({ type: "stepStart" });
          },
          onToken: (delta) => {
            if (!firstTokenAt) firstTokenAt = Date.now();
            streamedChars += delta.length;
            this.view?.webview.postMessage({ type: "token", value: delta });
          },
          onAssistantText: (txt) => {
            this.view?.webview.postMessage({ type: "agentAnswer", value: txt });
          },
          onToolStart: (name, args) => {
            this.view?.webview.postMessage({ type: "toolStart", name, args });
          },
          onToolResult: (name, result) => {
            this.view?.webview.postMessage({ type: "toolResult", name, result });
          },
          onStatus: (status) => {
            this.view?.webview.postMessage({ type: "status", value: status });
          },
        },
        toolCtx,
        signal,
        contextText,
        extraSystem
      );
      this.view?.webview.postMessage({
        type: "done",
        stats: this.makeStats("x".repeat(streamedChars), started, firstTokenAt),
      });
    } catch (err: any) {
      if (this.abort?.signal.aborted) {
        this.view?.webview.postMessage({ type: "done" });
        await this.maybeAutopilotRecover();
      } else {
        this.view?.webview.postMessage({ type: "error", value: err?.message ?? String(err) });
      }
    }
  }

  /** Confirmation gate for mutating tools, honoring the auto-approve setting. */
  private async confirmWrite(summary: string, detail: string): Promise<boolean> {
    const auto = vscode.workspace
      .getConfiguration("localai")
      .get<boolean>("agent.autoApproveWrites");
    if (auto || this.approveAllWrites) return true;

    const choice = await vscode.window.showWarningMessage(
      summary,
      { modal: true, detail },
      "Allow",
      "Allow for this session"
    );
    if (choice === "Allow for this session") {
      this.approveAllWrites = true;
      return true;
    }
    return choice === "Allow";
  }

  /**
   * Deterministic "Apply" — writes a code block to a file the user picks.
   * Unlike agent write_file, this does not depend on the model: the user
   * clicked Apply, so we just confirm the path and write.
   */
  private async applyCode(code: string, lang: string) {
    if (!code.trim()) {
      vscode.window.showWarningMessage("CvSU-AI VSCode Chat: nothing to apply.");
      return;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage("CvSU-AI VSCode Chat: open a workspace folder to apply code.");
      return;
    }

    const target = await vscode.window.showInputBox({
      prompt: "Apply code to which file? (workspace-relative path)",
      value: suggestPath(lang),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Enter a file path."),
    });
    if (!target) return;

    const rel = target.trim().replace(/^\/+/, "");
    const uri = vscode.Uri.joinPath(folders[0].uri, rel);

    // Detect overwrite and offer append for existing files.
    let exists = false;
    try {
      await vscode.workspace.fs.stat(uri);
      exists = true;
    } catch {
      /* new file */
    }

    let finalContent = code;
    if (exists) {
      const choice = await vscode.window.showWarningMessage(
        `${rel} already exists.`,
        { modal: true, detail: "Overwrite it, or append the code to the end?" },
        "Overwrite",
        "Append"
      );
      if (choice === "Append") {
        const existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        finalContent = existing.replace(/\s*$/, "") + "\n\n" + code + "\n";
      } else if (choice !== "Overwrite") {
        return; // cancelled
      }
    }

    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(finalContent, "utf8"));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(`Applied code to ${rel}.`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to write ${rel}: ${err?.message ?? String(err)}`);
    }
  }

  private html(): string {
    // Only called from resolveWebviewView, where this.view is set.
    const webview = this.view!.webview;
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.css")
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.js")
    );
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "cvsu-logo.png")
    );
    // Command list for the webview's /slash menu (escape < to keep it inside the script tag).
    const slashData = JSON.stringify(
      allSlashCommands().map((c) => ({ name: c.name, description: c.description }))
    ).replace(/</g, "\\u003c");
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>CVSU AI DEV</title>
</head>
<body>
  <div id="app">
    <header id="topbar">
      <div class="brand"><img class="brand-logo" src="${logoUri}" alt="LocalAI" /> CVSU AI DEV</div>
      <span class="topbar-actions">
        <button id="reload" class="ghost" title="Reload settings and models">↻</button>
        <button id="target-toggle" class="ghost target-chip" title="Switch between the server and your local GPU">AI: …</button>
        <button id="history" class="ghost" title="Chat history">History</button>
        <button id="new-chat" class="ghost" title="New chat">＋ New</button>
      </span>
    </header>
    <div id="history-panel" hidden aria-label="Chat history">
      <div class="history-head">
        <span>Chat history</span>
        <button id="history-close" class="ghost" title="Close">✕</button>
      </div>
      <div id="history-list"></div>
    </div>
    <div id="messages">
      <div id="empty">
        <img class="empty-logo" src="${logoUri}" alt="LocalAI logo" />
        <h2>CVSU AI DEV</h2>
        <p>Ask a question, or type <code>/</code> for commands. Enable Agent mode to edit files.</p>
        <div id="signin-container" style="display:none; margin-top: 20px;">
          <button id="signin-btn" class="primary-btn" style="padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground);">Sign In to LocalAI</button>
        </div>
      </div>
    </div>
    <div id="composer">
      <div id="slash-menu" hidden></div>
      <div class="input-wrap">
        <textarea id="input" rows="1" placeholder="Ask CVSU AI DEV…  (type / for commands)"></textarea>
        <button id="send" title="Send (Enter)" aria-label="Send">➤</button>
        <button id="stop" title="Stop" aria-label="Stop" style="display:none">■</button>
      </div>
      <div id="row">
        <label id="agentToggle" title="Let the assistant read, search, and edit workspace files">
          <input type="checkbox" id="agentMode" /> <span>Agent mode</span>
        </label>
        <label id="approveToggle" title="Skip file-write confirmation prompts when Agent mode edits files">
          <input type="checkbox" id="autoApproveWrites" /> <span>Auto-approve writes</span>
        </label>
        <label id="autopilotToggle" title="If a reply is interrupted/stopped, auto-compact old context then continue the response">
          <input type="checkbox" id="autopilotMode" /> <span>Autopilot</span>
        </label>
        <span id="status"></span>
        <select id="model-select" title="Model used for replies">
          <option value="">model…</option>
        </select>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" type="application/json" id="slash-data">${slashData}</script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  /** Clean up listeners. VS Code owns the view lifecycle, so we don't dispose it. */
  dispose() {
    this.abort?.abort();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

/**
 * Max characters of conversation text we may send to summarize() so the request
 * fits the model's context window. Derived from localai.contextSize, reserving
 * room for the summary reply (SUMMARY_MAX_TOKENS) and the summarize prompt
 * wrapper (~250 tokens). ~4 chars/token, consistent with the rest of the code.
 */
function summaryInputCharCap(): number {
  const ctxTokens =
    vscode.workspace.getConfiguration("localai").get<number>("contextSize") ?? 4096;
  // Reserve the summary reply + the summarize prompt wrapper, plus a safety
  // margin (the ~4 chars/token estimate undercounts for dense code/JSON).
  const PROMPT_OVERHEAD = 512;
  const inputTokens = Math.max(512, ctxTokens - SUMMARY_MAX_TOKENS - PROMPT_OVERHEAD);
  return inputTokens * 4;
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

const LANG_EXT: Record<string, string> = {
  python: "py", py: "py", javascript: "js", js: "js", typescript: "ts", ts: "ts",
  tsx: "tsx", jsx: "jsx", json: "json", html: "html", css: "css", sh: "sh",
  bash: "sh", sql: "sql", go: "go", java: "java", yaml: "yaml", yml: "yml",
  md: "md", markdown: "md",
};

/**
 * Suggest a target path for an Apply, based on the active file and code language.
 * For a Python test of foo/bar.py → foo/test_bar.py; otherwise the active file's
 * folder + a generic name, falling back to the workspace root.
 */
function suggestPath(lang: string): string {
  const ext = LANG_EXT[lang.toLowerCase()] || (lang ? lang.toLowerCase() : "txt");
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.uri.scheme === "file") {
    const rel = vscode.workspace.asRelativePath(active.uri);
    const slash = rel.lastIndexOf("/");
    const dir = slash === -1 ? "" : rel.slice(0, slash + 1);
    const base = (slash === -1 ? rel : rel.slice(slash + 1)).replace(/\.[^.]+$/, "");
    if (ext === "py") return `${dir}test_${base}.py`;
    return `${dir}${base}.new.${ext}`;
  }
  return `new-file.${ext}`;
}
