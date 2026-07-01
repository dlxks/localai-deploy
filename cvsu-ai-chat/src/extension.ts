import * as vscode from "vscode";
import { ChatPanel } from "./chatPanel";
import { hasCredentials, listEmbeddingModels, getEmbeddingModel } from "./client";
import { signIn, signOut, ensureCredentials } from "./auth";
import { loadDevEnv } from "./env";
import { trackActiveEditor } from "./context";
import {
  currentTarget,
  setTarget,
  isLocalReachable,
  getServerUrl,
  getLocalUrl,
} from "./endpoints";
import { RagService } from "./ragService";
import { loadCustomConfig, watchCustomConfig, scaffoldCustomConfig, getCustomConfig } from "./customConfig";
import { setCustomCommands } from "./slashCommands";
import { LocalAIInlineCompletionProvider } from "./autocomplete";

let statusBar: vscode.StatusBarItem;
let targetBar: vscode.StatusBarItem;
let ragBar: vscode.StatusBarItem;
let rag: RagService;

export async function activate(context: vscode.ExtensionContext) {
  // Dev-only: seed process.env from .env in the extension root (Dev Host only).
  loadDevEnv(context);

  // Track the last real code editor so the chat stays aware of the open file
  // even after the webview takes focus.
  trackActiveEditor(context);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "cvsuai.openChat";
  context.subscriptions.push(statusBar);
  await refreshStatusBar(context);

  // Target toggle: shows Server vs Local and lets the user switch. Local is
  // auto-disabled when the local instance isn't reachable.
  targetBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  targetBar.command = "cvsuai.toggleTarget";
  context.subscriptions.push(targetBar);
  await refreshTargetBar();
  // Re-check local availability periodically so the toggle reflects reality.
  const poll = setInterval(() => void refreshTargetBar(), 15000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("localai.baseUrl")) void refreshTargetBar();
      if (e.affectsConfiguration("localai.target")) ChatPanel.current?.refreshUI();
      if (e.affectsConfiguration("localai.rag.enabled")) refreshRagBar();
    })
  );

  // Custom extensibility: load .cvsuai/ (instructions, skills, agents) and keep
  // it in sync. Reloading rebuilds the slash registry + refreshes the chat menu.
  const refreshCustom = async () => {
    await loadCustomConfig();
    setCustomCommands(getCustomConfig().commands);
    ChatPanel.current?.refreshSlashMenu();
  };
  void refreshCustom();
  watchCustomConfig(context, () => {
    setCustomCommands(getCustomConfig().commands);
    ChatPanel.current?.refreshSlashMenu();
  });

  // RAG: shared service + status bar. Load any existing index (non-blocking).
  rag = new RagService(context.globalStorageUri, context.secrets);
  ChatPanel.rag = rag;
  ragBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  ragBar.command = "cvsuai.indexWorkspace";
  context.subscriptions.push(ragBar);
  rag.load().then(() => refreshRagBar());
  refreshRagBar();

  // Register the chat as a native Activity Bar view (persists + auto-reopens).
  const chatProvider = new ChatPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewId, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Register Inline Autocomplete
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      new LocalAIInlineCompletionProvider(context.secrets)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cvsuai.openChat", () => ChatPanel.show(context)),

    vscode.commands.registerCommand("cvsuai.newChat", () => {
      ChatPanel.show(context);
      ChatPanel.current?.newChatFromCommand();
    }),

    vscode.commands.registerCommand("cvsuai.compactChat", async () => {
      ChatPanel.show(context);
      await ChatPanel.current?.compactNow(false);
    }),

    vscode.commands.registerCommand("cvsuai.openSettings", async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: "$(globe) Set Server URL", description: "Configure the URL for the CvSU AI Server" },
          { label: "$(key) Set Server API Key", description: "Set or change your Server API Key" },
          { label: "$(home) Set Local URL", description: "Configure the URL for your Local AI Server" },
          { label: "$(key) Set LocalDeploy API Key", description: "Set or change your Local API Key" },
          { label: "$(symbol-string) Set Text-Embedding Model", description: "Choose an installed embedding model for RAG" },
          { label: "$(sign-in) Sign In", description: "Sign in with GitHub or API Key" },
          { label: "$(sign-out) Sign Out", description: "Sign out of CvSU-AI VSCode Chat" },
          { label: "$(gear) Advanced Settings", description: "Opens VSCode Settings for all options" },
        ],
        { placeHolder: "CvSU-AI Settings" }
      );
      if (choice?.label.includes("Set Server URL")) {
        const current = vscode.workspace.getConfiguration("localai").get<string>("serverUrl");
        const val = await vscode.window.showInputBox({ prompt: "Enter Server URL", value: current });
        if (val !== undefined) {
           await vscode.workspace.getConfiguration("localai").update("serverUrl", val, vscode.ConfigurationTarget.Global);
           if (currentTarget() === "server") {
             await vscode.workspace.getConfiguration("localai").update("baseUrl", val, vscode.ConfigurationTarget.Global);
           }
        }
      } else if (choice?.label.includes("Set Server API Key")) {
        const val = await vscode.window.showInputBox({ prompt: "Paste your Server API key", password: true, ignoreFocusOut: true });
        if (val !== undefined) {
           await context.secrets.store("localai.serverApiKey", val.trim());
           vscode.window.showInformationMessage("Server API key saved.");
        }
      } else if (choice?.label.includes("Set Local URL")) {
        const current = vscode.workspace.getConfiguration("localai").get<string>("localUrl");
        const val = await vscode.window.showInputBox({ prompt: "Enter Local URL", value: current });
        if (val !== undefined) {
           await vscode.workspace.getConfiguration("localai").update("localUrl", val, vscode.ConfigurationTarget.Global);
           if (currentTarget() === "local") {
             await vscode.workspace.getConfiguration("localai").update("baseUrl", val, vscode.ConfigurationTarget.Global);
           }
        }
      } else if (choice?.label.includes("Set LocalDeploy API Key")) {
        const val = await vscode.window.showInputBox({ prompt: "Paste your LocalDeploy API key", password: true, ignoreFocusOut: true });
        if (val !== undefined) {
           await context.secrets.store("localai.localApiKey", val.trim());
           vscode.window.showInformationMessage("LocalDeploy API key saved.");
        }
      } else if (choice?.label.includes("Set Text-Embedding Model")) {
        try {
          let models = await listEmbeddingModels(context.secrets);
          const current = getEmbeddingModel();
          if (current && !models.includes(current)) models = [current, ...models];
          if (!models.length) {
            vscode.window.showWarningMessage(
              "CvSU-AI VSCode Chat: no installed text-embedding models found on this server."
            );
          } else {
            const pick = await vscode.window.showQuickPick(
              models.map((m) => ({
                label: m,
                description: m === current ? "current" : "",
              })),
              { placeHolder: `Select text-embedding model (current: ${current})` }
            );
            if (pick?.label) {
              await vscode.workspace
                .getConfiguration("localai")
                .update("rag.embeddingModel", pick.label, vscode.ConfigurationTarget.Global);
              vscode.window.showInformationMessage(`Text-embedding model set to: ${pick.label}`);
            }
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(
            `CvSU-AI VSCode Chat: failed to fetch embedding models (${err?.message ?? String(err)}).`
          );
        }
      } else if (choice?.label.includes("Sign In")) {
        await signIn(context.secrets);
      } else if (choice?.label.includes("Sign Out")) {
        await signOut(context.secrets);
      } else if (choice?.label.includes("Advanced Settings")) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "localai");
      }
    }),

    vscode.commands.registerCommand("cvsuai.chatSelection", () => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor?.document.getText(editor.selection).trim();
      if (!selected) {
        vscode.window.showWarningMessage("CvSU-AI VSCode Chat: nothing selected.");
        return;
      }
      ChatPanel.show(context);
      // The view may take a moment to resolve; sendInitial retries internally.
      setTimeout(() => ChatPanel.current?.sendInitial(selected), 400);
    }),

    vscode.commands.registerCommand("cvsuai.signIn", async () => {
      const ok = await signIn(context.secrets);
      if (ok) ChatPanel.current?.refreshUI();
      await refreshStatusBar(context);
    }),

    vscode.commands.registerCommand("cvsuai.signOut", async () => {
      await signOut(context.secrets);
      ChatPanel.current?.refreshUI();
      await refreshStatusBar(context);
    }),

    vscode.commands.registerCommand("cvsuai.toggleTarget", async () => {
      const target = currentTarget();
      if (target === "server") {
        // Switching TO local — only allowed if it's actually reachable.
        if (!(await isLocalReachable())) {
          vscode.window.showWarningMessage(
            `CvSU-AI VSCode Chat: local instance not reachable at ${getLocalUrl()}. ` +
              `Start it (docker compose up -d) and try again.`
          );
          await refreshTargetBar();
          return;
        }
        await setTarget("local");
        notifySwitched("local");
      } else {
        // Switching back to the shared server (always available).
        await setTarget("server");
        notifySwitched("server");
      }
      await refreshTargetBar();
    }),

    vscode.commands.registerCommand("cvsuai.indexWorkspace", async () => {
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage("CvSU-AI VSCode Chat: open a folder to index.");
        return;
      }
      if (rag.isBusy) {
        vscode.window.showInformationMessage("CvSU-AI VSCode Chat: indexing is already running.");
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "CvSU-AI VSCode Chat: indexing workspace", cancellable: true },
        async (progress, token) => {
          try {
            await rag.buildIndex(token, (msg) => progress.report({ message: msg }));
            const s = rag.stats();
            vscode.window.showInformationMessage(`CvSU-AI VSCode Chat: indexed ${s.chunks} chunks from ${s.files} files. Use /codebase to ask.`);
          } catch (err: any) {
            vscode.window.showErrorMessage(`CvSU-AI VSCode Chat index error: ${err?.message ?? String(err)}`);
          }
          refreshRagBar();
        }
      );
    }),

    vscode.commands.registerCommand("cvsuai.showRAGStats", () => {
      const s = rag.stats();
      vscode.window.showInformationMessage(
        rag.ready
          ? `CvSU-AI VSCode Chat RAG: ${s.chunks} chunks from ${s.files} files indexed.`
          : "CvSU-AI VSCode Chat RAG: no index yet. Run “CvSU-AI VSCode Chat: Index Workspace for RAG”."
      );
    }),

    vscode.commands.registerCommand("cvsuai.clearRAGIndex", async () => {
      await rag.clear();
      refreshRagBar();
      vscode.window.showInformationMessage("CvSU-AI VSCode Chat: RAG index cleared.");
    }),

    vscode.commands.registerCommand("cvsuai.customConfig", async () => {
      const root = await scaffoldCustomConfig();
      if (!root) return;
      await refreshCustom();
      const readme = vscode.Uri.joinPath(root, "instructions.md");
      try {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(readme));
      } catch {
        /* non-fatal */
      }
      vscode.window.showInformationMessage(
        "CvSU-AI VSCode Chat: created .cvsuai/ — add skills in skills/, agents in agents/, project rules in instructions.md. They appear as /commands."
      );
    }),

    vscode.commands.registerCommand("cvsuai.editKeybinding", async () => {
      await vscode.commands.executeCommand("workbench.action.openGlobalKeybindingsFile");
      vscode.window.showInformationMessage(
        "Find 'cvsuai.openChat' to customize the keyboard shortcut. Default: Ctrl+Shift+L (Cmd+Shift+L on Mac)."
      );
    })
  );
}

/**
 * Update the target toggle in the status bar: show whether we're on Server or
 * Local, and reflect whether Local is reachable. When on Local but it's down,
 * we surface a red warning so the user knows requests will fail.
 */
let lastLocalUp: boolean | undefined = undefined;

async function refreshTargetBar() {
  if (!targetBar) return;
  const target = currentTarget();
  const localUp = await isLocalReachable();

  if (lastLocalUp !== undefined && lastLocalUp !== localUp) {
    ChatPanel.current?.refreshUI();
  }
  lastLocalUp = localUp;

  if (target === "local") {
    if (localUp) {
      targetBar.text = "$(vm-active) AI: Local";
      targetBar.tooltip = `CvSU-AI VSCode Chat — using LOCAL GPU (${getLocalUrl()}). Click to switch to the server.`;
      targetBar.backgroundColor = undefined;
    } else {
      // On local but it's not answering — warn (requests will fail).
      targetBar.text = "$(warning) AI: Local (down)";
      targetBar.tooltip =
        `CvSU-AI VSCode Chat — local instance at ${getLocalUrl()} is NOT responding. ` +
        `Start it, or click to switch back to the server.`;
      targetBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
  } else {
    // On server. Indicate whether local is available to switch to.
    targetBar.text = "$(cloud) AI: Server";
    targetBar.tooltip = localUp
      ? `CvSU-AI VSCode Chat — using the server (${getServerUrl()}). Click to switch to your LOCAL GPU.`
      : `CvSU-AI VSCode Chat — using the server (${getServerUrl()}). Local instance is offline (start it to enable switching).`;
    targetBar.backgroundColor = undefined;
  }
  targetBar.show();
}

/** Show RAG index status in the status bar (only when RAG is enabled). */
function refreshRagBar() {
  if (!ragBar) return;
  const enabled = vscode.workspace.getConfiguration("localai").get<boolean>("rag.enabled");
  if (!enabled) {
    ragBar.hide();
    return;
  }
  if (rag?.isBusy) {
    ragBar.text = "$(sync~spin) RAG: indexing…";
  } else if (rag?.ready) {
    const s = rag.stats();
    ragBar.text = `$(book) RAG: ${s.files} files`;
    ragBar.tooltip = `${s.chunks} chunks indexed. Click to reindex. Ask with /codebase.`;
  } else {
    ragBar.text = "$(book) RAG: not indexed";
    ragBar.tooltip = "Click to index the workspace for /codebase search.";
  }
  ragBar.show();
}

function notifySwitched(target: "server" | "local") {
  const where = target === "local" ? `your LOCAL GPU (${getLocalUrl()})` : `the server (${getServerUrl()})`;
  vscode.window
    .showInformationMessage(`CvSU-AI VSCode Chat: now using ${where}.`, "Reload Window")
    .then((choice) => {
      if (choice === "Reload Window") {
        vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    });
}

async function refreshStatusBar(context: vscode.ExtensionContext) {
  const signedIn = await hasCredentials(context.secrets);
  statusBar.text = signedIn ? "$(sparkle) LocalAI" : "$(sign-in) LocalAI";
  statusBar.tooltip = signedIn
    ? "CvSU-AI VSCode Chat — open chat"
    : "CvSU-AI VSCode Chat — click to sign in";
  statusBar.command = signedIn ? "cvsuai.openChat" : "cvsuai.signIn";
  statusBar.show();
}

export function deactivate() {
  statusBar?.dispose();
  targetBar?.dispose();
  ragBar?.dispose();
}
