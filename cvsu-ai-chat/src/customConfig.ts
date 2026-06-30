import * as vscode from "vscode";

/**
 * User-defined extensibility loaded from a `.cvsuai/` folder in the workspace:
 *
 *   .cvsuai/
 *     instructions.md        -> always prepended to the system prompt
 *     skills/<name>.md       -> a custom /name command (read-only prompt template)
 *     agents/<name>.md       -> a custom /name agent (runs in agent mode with its
 *                               own system prompt; can read/edit files)
 *
 * Each skill/agent .md has optional YAML-ish frontmatter (description) and a body
 * that is the prompt (skills) or the agent system prompt (agents). In skill
 * bodies, `$ARGUMENTS` is replaced with any text typed after the command.
 */

export interface CustomCommand {
  name: string;
  description: string;
  /** Skills: the prompt template. Agents: the agent system prompt. */
  body: string;
  /** True for agents/* (runs in agent mode with tools). */
  isAgent: boolean;
}

export interface CustomConfig {
  instructions: string;
  commands: CustomCommand[];
}

let cached: CustomConfig = { instructions: "", commands: [] };

export function getCustomConfig(): CustomConfig {
  return cached;
}

/** Parse simple `---\nkey: value\n---\nbody` frontmatter. Returns {meta, body}. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2].trim() };
}

async function readDirSafe(dir: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return [];
  }
}

async function readTextSafe(uri: vscode.Uri): Promise<string> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return "";
  }
}

async function loadCommandsFrom(dir: vscode.Uri, isAgent: boolean): Promise<CustomCommand[]> {
  const out: CustomCommand[] = [];
  for (const [file, type] of await readDirSafe(dir)) {
    if (type !== vscode.FileType.File || !file.toLowerCase().endsWith(".md")) continue;
    const name = file.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!name) continue;
    const { meta, body } = parseFrontmatter(await readTextSafe(vscode.Uri.joinPath(dir, file)));
    if (!body) continue;
    out.push({
      name,
      description: meta.description || (isAgent ? `Custom agent: ${name}` : `Custom skill: ${name}`),
      body,
      isAgent,
    });
  }
  return out;
}

/** (Re)load .cvsuai/ from the first workspace folder into the cache. */
export async function loadCustomConfig(): Promise<CustomConfig> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    cached = { instructions: "", commands: [] };
    return cached;
  }
  const root = vscode.Uri.joinPath(folder.uri, ".cvsuai");
  const instructions = await readTextSafe(vscode.Uri.joinPath(root, "instructions.md"));
  const skills = await loadCommandsFrom(vscode.Uri.joinPath(root, "skills"), false);
  const agents = await loadCommandsFrom(vscode.Uri.joinPath(root, "agents"), true);
  cached = { instructions: instructions.trim(), commands: [...skills, ...agents] };
  return cached;
}

/** Watch .cvsuai/ and reload on change; calls onChange after each reload. */
export function watchCustomConfig(
  context: vscode.ExtensionContext,
  onChange: () => void
): void {
  const watcher = vscode.workspace.createFileSystemWatcher("**/.cvsuai/**");
  const reload = async () => {
    await loadCustomConfig();
    onChange();
  };
  watcher.onDidChange(reload);
  watcher.onDidCreate(reload);
  watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);
}

/** Scaffold a starter .cvsuai/ folder with examples. */
export async function scaffoldCustomConfig(): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage("CvSU-AI VSCode Chat: open a folder first.");
    return undefined;
  }
  const root = vscode.Uri.joinPath(folder.uri, ".cvsuai");
  const enc = (s: string) => Buffer.from(s, "utf8");
  const write = async (rel: string, content: string) => {
    const uri = vscode.Uri.joinPath(root, rel);
    try {
      await vscode.workspace.fs.stat(uri); // don't overwrite existing
    } catch {
      await vscode.workspace.fs.writeFile(uri, enc(content));
    }
  };

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "skills"));
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "agents"));

  await write(
    "instructions.md",
    "# Project instructions\n\n" +
      "These notes are sent to the AI with every message in this workspace.\n\n" +
      "- This is a Frappe/ERPNext project; prefer Frappe APIs and conventions.\n" +
      "- Keep changes minimal and match the surrounding code style.\n"
  );
  await write(
    "skills/commit-msg.md",
    "---\ndescription: Draft a commit message for the selected diff/code\n---\n" +
      "Write a concise, conventional commit message for the provided changes. " +
      "One subject line (<=72 chars), then bullet points for what and why. $ARGUMENTS\n"
  );
  await write(
    "agents/reviewer.md",
    "---\ndescription: Senior code reviewer that reads files and reports findings\n---\n" +
      "You are a meticulous senior code reviewer. Read the relevant files, then " +
      "report concrete findings ordered by severity (correctness > security > " +
      "maintainability), each with a file:line reference and a suggested fix. " +
      "Do not rewrite files unless explicitly asked.\n"
  );
  return root;
}
