import * as vscode from "vscode";
import { EXCLUDE_GLOB } from "./tools";

// The server model is loaded with a small context window (4096 tokens). We must
// keep the attached context well under that, leaving room for the system prompt,
// the user's question, the conversation, and the model's reply. ~4 chars/token,
// so a 2500-token budget ≈ 10000 chars. Configurable via localai.contextTokenBudget
// so it can grow if the admin raises the server-side context size.
const DEFAULT_TOKEN_BUDGET = 2500;
const CHARS_PER_TOKEN = 4;
const MAX_TREE_FILES = 200;

function contextCharBudget(): number {
  const tokens =
    vscode.workspace.getConfiguration("localai").get<number>("contextTokenBudget") ??
    DEFAULT_TOKEN_BUDGET;
  return Math.max(500, tokens) * CHARS_PER_TOKEN;
}

export interface EditorContext {
  /** Short human label of what was attached, shown in the UI (e.g. "selection in foo.py"). */
  label: string;
  /** System-message text injected for this turn, or "" when there's nothing to add. */
  systemText: string;
  /** Workspace-relative path of the open file whose contents are embedded above,
   *  if any. The agent uses this to short-circuit a read_file on that same file
   *  (it already has the contents) — preventing a wasteful double-count. */
  openFile?: string;
}

/**
 * Last real code editor the user touched. We cache it because once the chat
 * webview takes focus, vscode.window.activeTextEditor becomes undefined — so
 * relying on it alone makes the assistant blind to the file the user is on.
 */
let lastActiveEditor: vscode.TextEditor | undefined;

/**
 * True only for a genuine editable workspace file — excludes the Output panel,
 * Debug Console, Git diffs, terminals, settings UI, search results, etc., which
 * also appear as "text editors" but are not files the user is coding in.
 */
function isRealFileEditor(ed: vscode.TextEditor | undefined): ed is vscode.TextEditor {
  if (!ed) return false;
  const doc = ed.document;
  if (doc.uri.scheme !== "file") return false; // output:, git:, vscode-*:, untitled:, etc.
  if (doc.isClosed) return false;
  // Output channels can masquerade with odd names; require a path with an extension
  // and reject the telltale "extension-output-" pseudo-docs.
  const path = doc.uri.fsPath;
  if (/extension-output-/.test(path)) return false;
  return true;
}

/** Call once from activate() to keep lastActiveEditor current. */
export function trackActiveEditor(context: vscode.ExtensionContext): void {
  if (isRealFileEditor(vscode.window.activeTextEditor)) {
    lastActiveEditor = vscode.window.activeTextEditor;
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      // Only update on real workspace files; ignore panels/webviews/output.
      if (isRealFileEditor(ed)) {
        lastActiveEditor = ed;
      }
    })
  );
}

/**
 * Resolve the editor whose file we should treat as "the current file":
 *   active real-file editor → last tracked real-file editor → first visible real file.
 */
function resolveEditor(): vscode.TextEditor | undefined {
  if (isRealFileEditor(vscode.window.activeTextEditor)) {
    return vscode.window.activeTextEditor;
  }
  if (isRealFileEditor(lastActiveEditor)) {
    return lastActiveEditor;
  }
  return vscode.window.visibleTextEditors.find(isRealFileEditor);
}

/**
 * Gather context for a chat turn, in priority order:
 *   1. Active editor selection (if non-empty).
 *   2. The whole active file.
 *   3. A compact workspace file listing (when no editor is open).
 *
 * `forAgent` trims the payload: agent mode has read_file/list_files/search tools,
 * so we hand it the path + a peek rather than the entire file/tree.
 */
export async function gatherContext(forAgent: boolean): Promise<EditorContext> {
  const editor = resolveEditor();

  if (editor && !editor.document.isUntitled) {
    const doc = editor.document;
    // false = exclude the workspace-folder name prefix, so the path is relative
    // to its containing folder — matching what the file tools resolve against
    // (resolveExisting/resolveForWrite check each folder). With the prefix, a
    // multi-root path like "frappe-bench-lite/accounting/.." would never resolve.
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    const sel = editor.selection;

    const budget = contextCharBudget();

    // 1. Selection
    if (sel && !sel.isEmpty) {
      const selected = doc.getText(sel);
      const startLine = sel.start.line + 1;
      const endLine = sel.end.line + 1;
      const [code, cut] = clamp(selected, budget);
      // In agent mode, hand the EXACT paths so it never has to guess/read_file
      // for this file (a common failure: truncating or mis-resolving the path).
      const pathNote = forAgent ? await agentPathGuidance(rel) : "";
      return {
        label: `selection in ${rel} (L${startLine}–${endLine})${cut ? " · trimmed" : ""}`,
        systemText:
          `The user has selected lines ${startLine}-${endLine} of \`${rel}\` ` +
          `(language: ${doc.languageId}). Selected code:\n\n` +
          fence(doc.languageId, code) +
          pathNote,
      };
    }

    // 2. Whole active file — embed the content directly (both modes), so the
    // model never has to guess a path and call read_file for the OPEN file.
    const full = doc.getText();
    const [code, cut] = clamp(full, budget);
    if (forAgent) {
      // Embed an existing test file's contents (when small enough) so the agent
      // can append to it WITHOUT a read_file round-trip — the #1 cause of loops.
      const testGuidance = await existingTestGuidance(rel);
      return {
        label: `open file: ${rel}${cut ? " · trimmed" : ""}`,
        openFile: rel,
        systemText:
          `The user's active file is \`${rel}\` (${doc.lineCount} lines, language ${doc.languageId}). ` +
          `Its current contents are below — use these directly; do NOT call read_file for this file ` +
          `(call read_file/search only for OTHER files, using workspace-relative paths)` +
          (cut ? ". Content was trimmed to fit the context window" : "") +
          `:\n\n` +
          fence(doc.languageId, code) +
          testGuidance,
      };
    }
    return {
      label: `open file: ${rel}${cut ? " · trimmed to fit" : ""}`,
      systemText:
        `The user's active file is \`${rel}\` (language: ${doc.languageId})` +
        (cut ? " — content was trimmed to fit the model's context window" : "") +
        `. Contents:\n\n` +
        fence(doc.languageId, code),
    };
  }

  // 3. No editor — fall back to the workspace.
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { label: "", systemText: "" };
  }

  const uris = await vscode.workspace.findFiles("**/*", EXCLUDE_GLOB, MAX_TREE_FILES);
  const rels = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort((a, b) => a.localeCompare(b));
  const truncatedNote =
    uris.length >= MAX_TREE_FILES ? `\n…(showing first ${MAX_TREE_FILES} files)` : "";

  if (forAgent) {
    return {
      label: `workspace (${rels.length} files)`,
      systemText:
        `No file is open. The workspace root is \`${folders[0].name}\`. ` +
        `Use list_files / search / read_file tools to explore it as needed.`,
    };
  }
  const [listing] = clamp(rels.join("\n"), contextCharBudget());
  return {
    label: `workspace (${rels.length} files)`,
    systemText:
      `No file is open. Workspace \`${folders[0].name}\` contains these files:\n\n` +
      listing +
      truncatedNote,
  };
}

/**
 * Give the agent the EXACT workspace paths for the current file so it never has
 * to guess (the #1 cause of read_file loops). Includes the conventional test
 * path next to the source file, and flags an existing test to append to.
 */
async function agentPathGuidance(rel: string): Promise<string> {
  const slash = rel.lastIndexOf("/");
  const dir = slash === -1 ? "" : rel.slice(0, slash + 1);
  const file = slash === -1 ? rel : rel.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  const conventionalTest = `${dir}test_${base}${ext}`;

  const existingTest = await findExistingTestFile(rel);
  const lines = [
    `\n\nEXACT PATHS (use these verbatim — do NOT guess, truncate, or use absolute paths):`,
    `- This file: \`${rel}\``,
    `- Its directory: \`${dir || "(workspace root)"}\``,
  ];
  if (!existingTest) {
    lines.push(
      `- To create a unit test, write to \`${conventionalTest}\` (same directory as the source). Call write_file with that exact path.`
    );
  }
  lines.push(
    `If you must explore, call list_files (no args) to get exact paths. Never pass absolute paths to read_file/write_file.`
  );
  // When a test file exists, embed its contents so the agent can append without
  // a read_file round-trip (falls back to "read it first" if it's too big).
  return lines.join("\n") + (await existingTestGuidance(rel));
}

/**
 * If a conventional test file already exists for `rel`, return a guidance block.
 * When the file is small enough, EMBED its full contents so the agent can append
 * to it directly without a read_file round-trip (the #1 source of agent loops).
 * For larger test files, just point the agent at the path to read first.
 * Returns "" when no test file exists.
 */
async function existingTestGuidance(rel: string): Promise<string> {
  const existingTest = await findExistingTestFile(rel);
  if (!existingTest) return "";

  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return "";

  // ~1500 tokens; bigger test files aren't embedded (we tell the agent to read it).
  const TEST_EMBED_MAX = 6000;
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(folders[0].uri, existingTest)
    );
    const content = Buffer.from(bytes).toString("utf8");
    if (content.length <= TEST_EMBED_MAX) {
      const dot = existingTest.lastIndexOf(".");
      const lang = dot >= 0 ? existingTest.slice(dot + 1) : "";
      return (
        `\n\nThe target test file \`${existingTest}\` ALREADY EXISTS. Its full current ` +
        `contents are below — you already have them, so do NOT call read_file for it. ` +
        `To add tests, call append_to_file with path \`${existingTest}\` (preferred), or ` +
        `write_file with "overwrite": true and the COMPLETE merged content:\n\n` +
        fence(lang, content)
      );
    }
  } catch {
    /* fall through to the read-first note */
  }
  return (
    `\n\nNOTE: a test file already exists at \`${existingTest}\`. Read it first ` +
    `(read_file), then ADD to it with append_to_file — do NOT overwrite it.`
  );
}

/**
 * For a source file like foo/bar.py, look for an already-existing test file in
 * the conventional locations and return the first that exists (workspace-relative).
 */
async function findExistingTestFile(rel: string): Promise<string | undefined> {
  const slash = rel.lastIndexOf("/");
  const dir = slash === -1 ? "" : rel.slice(0, slash + 1);
  const file = slash === -1 ? rel : rel.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const base = file.slice(0, dot);
  const ext = file.slice(dot); // includes the dot, e.g. ".py"

  const candidates = [
    `${dir}test_${base}${ext}`,
    `${dir}${base}_test${ext}`,
    `${dir}tests/test_${base}${ext}`,
    `tests/test_${base}${ext}`,
    `${dir}${base}.test${ext}`,
    `${dir}__tests__/${base}.test${ext}`,
  ];

  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return undefined;
  for (const cand of candidates) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folders[0].uri, cand));
      return cand;
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/** Cap text to `max` chars. Returns [text, wasTruncated]. */
function clamp(text: string, max: number): [string, boolean] {
  if (text.length <= max) return [text, false];
  return [text.slice(0, max) + "\n…[truncated]", true];
}

function fence(lang: string, code: string): string {
  return "```" + (lang || "") + "\n" + code + "\n```";
}
