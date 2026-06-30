import * as vscode from "vscode";
import { ToolDef } from "./client";

export interface ToolContext {
  /** Ask the user to approve a mutating action. Returns true to proceed. */
  confirm: (summary: string, detail: string) => Promise<boolean>;
  /** Workspace-relative path of the open file already embedded in this turn's
   *  context. read_file on this path is short-circuited (the model already has
   *  the contents) to avoid double-counting it against the context window. */
  openFilePath?: string;
}

/** True if the model-requested path refers to the same file as `openFilePath`. */
function sameAsOpenFile(requested: string, openFilePath?: string): boolean {
  if (!openFilePath) return false;
  const a = normalizeInput(requested).replace(/^\.?\//, "").toLowerCase();
  const b = normalizeInput(openFilePath).replace(/^\.?\//, "").toLowerCase();
  if (!a || !b) return false;
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}

export interface AgentTool {
  def: ToolDef;
  /** Read-only tools run without confirmation; mutating ones go through ctx.confirm. */
  mutating: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

const MAX_OUTPUT = 20000; // cap tool output so we don't blow the context window

/**
 * Files/dirs to hide from list_files & search — build artifacts, VCS, caches,
 * and tool logs (e.g. .playwright-mcp console dumps) that just waste the model's
 * tiny context window.
 */
export const EXCLUDE_GLOB =
  "{**/node_modules/**,**/.git/**,**/.playwright-mcp/**,**/__pycache__/**," +
  "**/dist/**,**/build/**,**/.venv/**,**/venv/**,**/*.log,**/.DS_Store," +
  "**/*.pyc,**/.pytest_cache/**,**/.mypy_cache/**,**/coverage/**}";

function clamp(text: string): string {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n…[truncated]" : text;
}

function workspaceRoot(): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("No workspace folder is open. Open a folder in VS Code to use file tools.");
  }
  return folders[0].uri;
}

/** Normalize a model-supplied path: backslashes → slashes, collapse "//". */
function normalizeInput(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/** Is this an absolute path? (Windows "C:/..." or POSIX "/...") */
function isAbsolute(p: string): boolean {
  return /^[a-zA-Z]:\//.test(p) || p.startsWith("/");
}

/**
 * Resolve a model-supplied path to a real file URI, and refuse anything outside
 * the open workspace folders.
 *
 * The model often passes paths in inconsistent forms — workspace-relative,
 * absolute Windows paths, or (when confused) absolute paths concatenated onto a
 * relative one. We handle all of these:
 *   1. Absolute path that lives inside ANY open workspace folder -> use it.
 *   2. Relative path -> resolve against each workspace folder, first that exists.
 *   3. A relative path with an absolute path embedded in it (the "doubled path"
 *      bug, e.g. "apps/c:/Users/...") -> recover the absolute tail and retry.
 */
function resolveInWorkspace(relPath: string): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("No workspace folder is open. Open a folder in VS Code to use file tools.");
  }

  let p = normalizeInput(relPath);
  if (!p) throw new Error("Empty path.");

  // Recover from a doubled path: "<relative>/<absolute>" -> "<absolute>".
  const embedded = p.match(/([a-zA-Z]:\/.*)$/);
  if (embedded && !isAbsolute(p)) {
    p = embedded[1];
  }

  const within = (folderPath: string, targetPath: string) => {
    const base = folderPath.endsWith("/") ? folderPath : folderPath + "/";
    return targetPath === folderPath || targetPath.startsWith(base);
  };

  if (isAbsolute(p)) {
    // Match the absolute path to whichever open folder contains it (case-
    // insensitive on Windows drive letters / paths).
    const target = vscode.Uri.file(p.replace(/^([a-zA-Z]):/, (_m, d) => `${d}:`));
    const tNorm = target.path.toLowerCase();
    for (const f of folders) {
      if (within(f.uri.path.toLowerCase(), tNorm)) return target;
    }
    throw new Error(
      `Path "${relPath}" is outside the open workspace folder(s). ` +
        `Use a path relative to the workspace, or open that folder in VS Code.`
    );
  }

  // Relative: try each workspace folder; prefer one where the file exists.
  const candidates = folders.map((f) => vscode.Uri.joinPath(f.uri, p));
  for (const c of candidates) {
    // Cheap existence check via stat is async; we return the first candidate and
    // let the caller's fs op surface ENOENT. But guard against escapes here.
    if (!within(folders.find((f) => c.path.startsWith(f.uri.path))!.uri.path, c.path)) {
      continue;
    }
  }
  // Default to the first folder (preserves existing behavior for single-root).
  const target = candidates[0];
  if (!within(folders[0].uri.path, target.path)) {
    throw new Error(`Path "${relPath}" escapes the workspace root.`);
  }
  return target;
}

/** Resolve, preferring whichever workspace folder actually has the file. */
export async function resolveExisting(relPath: string): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const p = normalizeInput(relPath);
  if (!isAbsolute(p) && folders.length > 1) {
    for (const f of folders) {
      const c = vscode.Uri.joinPath(f.uri, p);
      try {
        await vscode.workspace.fs.stat(c);
        return c;
      } catch {
        /* try next folder */
      }
    }
  }
  // Fallback: the file the user is looking at may be OPEN but live outside any
  // workspace folder (so relative-path resolution fails). Match the requested
  // path against open documents by suffix and use the real URI if found.
  const openMatch = matchOpenDocument(p);
  if (openMatch) return openMatch;

  return resolveInWorkspace(relPath);
}

/**
 * Find an open editor/document whose path ends with the requested (normalized)
 * path. Lets the agent read files the user has open even when their folder
 * isn't part of the VS Code workspace.
 */
function matchOpenDocument(p: string): vscode.Uri | undefined {
  const want = p.replace(/^\.?\//, "").toLowerCase();
  if (!want) return undefined;
  const docs = vscode.workspace.textDocuments
    .filter((d) => d.uri.scheme === "file")
    .map((d) => d.uri);
  // Prefer an exact suffix match on a path boundary (…/<want>).
  const exact = docs.find((u) => {
    const lp = u.path.toLowerCase();
    return lp === want || lp.endsWith("/" + want);
  });
  if (exact) return exact;
  // Else match on basename as a last resort (single file name).
  if (!want.includes("/")) {
    return docs.find((u) => u.path.toLowerCase().endsWith("/" + want));
  }
  return undefined;
}

/**
 * Resolve a path for WRITING (the file may not exist yet). For a relative path in
 * a multi-root workspace, pick the folder whose target DIRECTORY already exists —
 * so a new test file lands next to its source, not in the wrong root.
 */
async function resolveForWrite(relPath: string): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const p = normalizeInput(relPath);
  if (!isAbsolute(p) && folders.length > 1) {
    // 1. If the file already exists in some folder, use that.
    for (const f of folders) {
      const c = vscode.Uri.joinPath(f.uri, p);
      try {
        await vscode.workspace.fs.stat(c);
        return c;
      } catch {
        /* not here */
      }
    }
    // 2. Else use the folder whose parent directory of the target exists.
    const slash = p.lastIndexOf("/");
    const dir = slash === -1 ? "" : p.slice(0, slash);
    if (dir) {
      for (const f of folders) {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.joinPath(f.uri, dir));
          return vscode.Uri.joinPath(f.uri, p);
        } catch {
          /* dir not in this folder */
        }
      }
    }
  }
  return resolveInWorkspace(relPath);
}

/** List workspace files (optionally under a sub-dir), workspace-relative. */
async function listWorkspaceFiles(dir = ""): Promise<string> {
  const clean = normalizeInput(dir).replace(/^\/+/, "").replace(/^\.\/?$/, "");
  const pattern = clean ? `${clean}/**/*` : "**/*";
  const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, 500);
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.path);
  const rel = (p: string) => {
    for (const r of roots) if (p.startsWith(r + "/")) return p.slice(r.length + 1);
    return p;
  };
  const rels = uris.map((u) => rel(u.path)).sort((a, b) => a.localeCompare(b));
  return clamp(rels.join("\n") || "(no files)");
}

/** True for paths that mean "the directory/root", not a file. */
function isDirLike(p: string): boolean {
  const n = normalizeInput(p);
  return n === "" || n === "." || n === "./" || n === "/" || n.endsWith("/");
}

const readFile: AgentTool = {
  mutating: false,
  def: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full UTF-8 contents of a file in the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative file path" } },
        required: ["path"],
      },
    },
  },
  async run(args, ctx) {
    const rel = String(args.path ?? "");
    // Forgiving: an empty/"."/"./" or trailing-slash path means "list this dir"
    // — the model often uses read_file to explore. Return a listing, not an error.
    if (isDirLike(rel)) {
      const listing = await listWorkspaceFiles(rel.replace(/\/+$/, ""));
      return `"${rel || "."}" is a directory. Files here:\n${listing}`;
    }
    // The open file's contents are already embedded in this turn's context — don't
    // read it again (that double-counts it against the window and is the #1 way a
    // /refactor on a large file blew past the context size).
    if (sameAsOpenFile(rel, ctx?.openFilePath)) {
      return (
        `"${rel}" is the OPEN file — its contents are already provided above in the ` +
        `context. Do NOT read it again; use what you already have. To change it, call ` +
        `write_file with "overwrite": true (and the complete new content) or append_to_file.`
      );
    }
    let uri: vscode.Uri;
    try {
      uri = await resolveExisting(rel);
    } catch (e: any) {
      return `Error: ${e?.message ?? String(e)}`;
    }
    // If it resolves to a directory, list it instead of failing.
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.type === vscode.FileType.Directory) {
        return `"${rel}" is a directory. Files here:\n${await listWorkspaceFiles(rel)}`;
      }
    } catch {
      /* fall through to read, which will give the not-found hint */
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return clamp(Buffer.from(bytes).toString("utf8"));
    } catch {
      // Don't let the model keep guessing paths — show it the real ones.
      return (
        `Error: could not read "${rel}" (not found). Available files:\n` +
        `${await listWorkspaceFiles("")}\n` +
        `Use one of the paths above verbatim. Do NOT guess or pass absolute paths.`
      );
    }
  },
};

const listFiles: AgentTool = {
  mutating: false,
  def: {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files in the workspace, optionally under a sub-directory. Returns up to 500 paths.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Workspace-relative directory (default root)" },
        },
      },
    },
  },
  async run(args) {
    return listWorkspaceFiles(String(args.dir ?? ""));
  },
};

const searchText: AgentTool = {
  mutating: false,
  def: {
    type: "function",
    function: {
      name: "search",
      description:
        "Search workspace file contents for a literal substring. Returns matching path:line: text.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for" },
          glob: { type: "string", description: "Optional include glob, e.g. **/*.ts" },
        },
        required: ["query"],
      },
    },
  },
  async run(args) {
    const query = String(args.query ?? "");
    if (!query) return "Error: 'query' is required.";
    const include = args.glob ? String(args.glob) : "**/*";
    const uris = await vscode.workspace.findFiles(include, EXCLUDE_GLOB, 300);
    const root = workspaceRoot().path;
    const hits: string[] = [];
    for (const uri of uris) {
      let text: string;
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(query)) {
          hits.push(`${uri.path.replace(root + "/", "")}:${i + 1}: ${lines[i].trim()}`);
          if (hits.length >= 200) break;
        }
      }
      if (hits.length >= 200) break;
    }
    return clamp(hits.join("\n") || `No matches for "${query}".`);
  },
};

const writeFile: AgentTool = {
  mutating: true,
  def: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a NEW file with the given UTF-8 content. To replace an EXISTING file you must read it first and pass overwrite:true with the complete merged content. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          content: { type: "string", description: "Full new file content" },
          overwrite: {
            type: "boolean",
            description:
              "Set true to replace an existing file. Only do this after reading the file. Omit for new files.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  async run(args, ctx) {
    const rel = String(args.path ?? "");
    const content = String(args.content ?? "");
    const overwrite = args.overwrite === true || String(args.overwrite) === "true";
    if (!rel) return "Error: 'path' is required.";
    let uri: vscode.Uri;
    try {
      uri = await resolveForWrite(rel);
    } catch (e: any) {
      return `Error: ${e?.message ?? String(e)}`;
    }

    let exists = false;
    try {
      await vscode.workspace.fs.stat(uri);
      exists = true;
    } catch {
      /* file does not exist */
    }

    // Guard: never silently clobber an existing file. Force the model to either
    // read it first and pass overwrite:true, or use append_to_file instead.
    if (exists && !overwrite) {
      return (
        `STOP: ${rel} ALREADY EXISTS. Do not blindly overwrite it. ` +
        `First call read_file({"path":"${rel}"}) to see its current contents, then either: ` +
        `(a) call append_to_file to ADD to it, or ` +
        `(b) call write_file again with the COMPLETE merged content AND "overwrite": true ` +
        `if you intend to replace the whole file.`
      );
    }

    const ok = await ctx.confirm(
      `${exists ? "Overwrite" : "Create"} ${rel}?`,
      `The agent wants to ${exists ? "OVERWRITE the existing" : "create a new"} file: ${rel}\n` +
        `(${content.length} characters, ${content.split("\n").length} lines)`
    );
    if (!ok) return `User denied writing ${rel}.`;

    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    await reveal(uri);
    return `Wrote ${content.length} characters to ${rel}. The file is now open in the editor.`;
  },
};

const appendToFile: AgentTool = {
  mutating: true,
  def: {
    type: "function",
    function: {
      name: "append_to_file",
      description:
        "Append content to the end of an existing file (e.g. add a new test to an existing test file) without rewriting it. Creates the file if missing. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          content: { type: "string", description: "Text to append at the end of the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  async run(args, ctx) {
    const rel = String(args.path ?? "");
    const addition = String(args.content ?? "");
    if (!rel) return "Error: 'path' is required.";
    if (!addition) return "Error: 'content' is required.";
    let uri: vscode.Uri;
    try {
      uri = await resolveExisting(rel);
    } catch (e: any) {
      return `Error: ${e?.message ?? String(e)}`;
    }

    let existing = "";
    try {
      existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      /* new file */
    }

    const ok = await ctx.confirm(
      `Append to ${rel}?`,
      `The agent wants to add ${addition.length} characters to the end of ${rel}.`
    );
    if (!ok) return `User denied appending to ${rel}.`;

    const merged = existing ? existing.replace(/\s*$/, "") + "\n\n" + addition + "\n" : addition + "\n";
    await vscode.workspace.fs.writeFile(uri, Buffer.from(merged, "utf8"));
    await reveal(uri);
    return `Appended ${addition.length} characters to ${rel}. The file is now open in the editor.`;
  },
};

/** Open a file in the editor (best-effort). */
async function reveal(uri: vscode.Uri): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    /* non-fatal */
  }
}

export const TOOLS: AgentTool[] = [readFile, listFiles, searchText, writeFile, appendToFile];

export function toolDefs(): ToolDef[] {
  return TOOLS.map((t) => t.def);
}

export function findTool(name: string): AgentTool | undefined {
  return TOOLS.find((t) => t.def.function.name === name);
}
