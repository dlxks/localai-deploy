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
  /** True when sourced from a .prompt.md file. */
  isPromptFile?: boolean;
  /** Optional allow-list for agent tools from frontmatter `tools:`. */
  allowedTools?: string[];
}

export interface CustomConfig {
  instructions: string;
  commands: CustomCommand[];
  promptFiles: Array<{ name: string; description: string }>;
  agentFiles: Array<{ name: string; description: string }>;
}

let cached: CustomConfig = { instructions: "", commands: [], promptFiles: [], agentFiles: [] };

export function getCustomConfig(): CustomConfig {
  return cached;
}

/** Parse simple `---\nkey: value\n---\nbody` frontmatter. Returns {meta, body}. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw.trim());
    if (!kv) continue;

    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (value) {
      meta[key] = value.replace(/^["']|["']$/g, "");
      continue;
    }

    // Support simple YAML-style list values, e.g.
    // tools:
    //   - read_file
    //   - search
    const list: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const item = /^\s*-\s*(.+)$/.exec(lines[j]);
      if (!item) break;
      list.push(item[1].trim().replace(/^["']|["']$/g, ""));
      j++;
    }
    if (list.length > 0) {
      meta[key] = list.join(",");
      i = j - 1;
    }
  }
  return { meta, body: m[2].trim() };
}

function slugName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function commandNameFromSkillPath(relPath: string): string {
  const p = relPath.replace(/\\/g, "/");
  if (p.toLowerCase().endsWith("/skill.md")) {
    const parts = p.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return slugName(parts[parts.length - 2]);
    }
  }
  const base = p.split("/").pop() ?? "";
  return slugName(base.replace(/\.md$/i, ""));
}

function commandNameFromPromptPath(relPath: string): string {
  const base = relPath.replace(/\\/g, "/").split("/").pop() ?? "";
  return slugName(base.replace(/\.prompt\.md$/i, ""));
}

function commandNameFromAgentPath(relPath: string): string {
  const base = relPath.replace(/\\/g, "/").split("/").pop() ?? "";
  return slugName(base.replace(/\.agent\.md$/i, ""));
}

function relPathFromWorkspaceUri(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return uri.path;
  const root = folder.uri.path.replace(/\/+$/, "");
  return uri.path.startsWith(root + "/") ? uri.path.slice(root.length + 1) : uri.path;
}

function modePrefersAgent(mode?: string): boolean {
  return mode?.toLowerCase() === "agent" || mode?.toLowerCase() === "edit";
}

function parseToolList(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const normalized = trimmed.replace(/\n/g, ",");
  const unwrapped = normalized.replace(/^\[(.*)\]$/, "$1").trim();
  const values = unwrapped
    .split(",")
    .map((s) => s.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  return values.length ? Array.from(new Set(values)) : undefined;
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
    const name = slugName(file.replace(/\.md$/i, ""));
    if (!name) continue;
    const { meta, body } = parseFrontmatter(await readTextSafe(vscode.Uri.joinPath(dir, file)));
    if (!body) continue;
    out.push({
      name,
      description: meta.description || (isAgent ? `Custom agent: ${name}` : `Custom skill: ${name}`),
      body,
      isAgent,
      allowedTools: isAgent ? parseToolList(meta.tools) : undefined,
    });
  }
  return out;
}

async function loadPromptFilesFromWorkspace(): Promise<CustomCommand[]> {
  const uris = await vscode.workspace.findFiles("**/*.prompt.md", "**/{node_modules,.git,dist,build}/**", 200);
  const out: CustomCommand[] = [];
  for (const uri of uris) {
    const raw = await readTextSafe(uri);
    const { meta, body } = parseFrontmatter(raw);
    if (!body) continue;
    const rel = relPathFromWorkspaceUri(uri);
    const name = commandNameFromPromptPath(rel);
    if (!name) continue;
    out.push({
      name,
      description: meta.description || `Prompt file: ${rel}`,
      body,
      isAgent: modePrefersAgent(meta.mode),
      isPromptFile: true,
      allowedTools: parseToolList(meta.tools),
    });
  }
  return out;
}

async function loadAgentFilesFromWorkspace(): Promise<CustomCommand[]> {
  const uris = await vscode.workspace.findFiles("**/*.agent.md", "**/{node_modules,.git,dist,build}/**", 200);
  const out: CustomCommand[] = [];
  for (const uri of uris) {
    const raw = await readTextSafe(uri);
    const { meta, body } = parseFrontmatter(raw);
    if (!body) continue;
    const rel = relPathFromWorkspaceUri(uri);
    const name = commandNameFromAgentPath(rel);
    if (!name) continue;
    out.push({
      name,
      description: meta.description || `Prompt agent: ${rel}`,
      body,
      isAgent: true,
      allowedTools: parseToolList(meta.tools),
    });
  }
  return out;
}

async function loadSkillFilesFromWorkspace(): Promise<CustomCommand[]> {
  const uris = await vscode.workspace.findFiles("**/SKILL.md", "**/{node_modules,.git,dist,build}/**", 300);
  const out: CustomCommand[] = [];
  for (const uri of uris) {
    const raw = await readTextSafe(uri);
    const { meta, body } = parseFrontmatter(raw);
    if (!body) continue;
    const rel = relPathFromWorkspaceUri(uri);
    const name = commandNameFromSkillPath(rel);
    if (!name) continue;
    out.push({
      name,
      description: meta.description || `Skill: ${rel}`,
      body,
      isAgent: false,
    });
  }
  return out;
}

async function loadInstructionsFromWorkspace(): Promise<string[]> {
  const files = [
    "**/*.instructions.md",
    "**/copilot-instructions.md",
    "**/AGENTS.md",
  ];
  const uris = new Map<string, vscode.Uri>();
  for (const pattern of files) {
    const matches = await vscode.workspace.findFiles(pattern, "**/{node_modules,.git,dist,build}/**", 100);
    for (const uri of matches) uris.set(uri.toString(), uri);
  }

  const chunks: string[] = [];
  const sorted = Array.from(uris.values()).sort((a, b) => a.path.localeCompare(b.path));
  for (const uri of sorted) {
    const text = (await readTextSafe(uri)).trim();
    if (!text) continue;
    const rel = relPathFromWorkspaceUri(uri);
    chunks.push(`[${rel}]\n${text}`);
  }
  return chunks;
}

/** (Re)load .cvsuai/ from the first workspace folder into the cache. */
export async function loadCustomConfig(): Promise<CustomConfig> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    cached = { instructions: "", commands: [], promptFiles: [], agentFiles: [] };
    return cached;
  }

  const root = vscode.Uri.joinPath(folder.uri, ".cvsuai");

  const localInstructions = (await readTextSafe(vscode.Uri.joinPath(root, "instructions.md"))).trim();
  const compatInstructions = await loadInstructionsFromWorkspace();

  const skills = await loadCommandsFrom(vscode.Uri.joinPath(root, "skills"), false);
  const agents = await loadCommandsFrom(vscode.Uri.joinPath(root, "agents"), true);
  const promptFiles = await loadPromptFilesFromWorkspace();
  const compatAgents = await loadAgentFilesFromWorkspace();
  const compatSkills = await loadSkillFilesFromWorkspace();

  const commandMap = new Map<string, CustomCommand>();
  for (const cmd of [...skills, ...agents, ...promptFiles, ...compatAgents, ...compatSkills]) {
    if (!cmd.name) continue;
    commandMap.set(cmd.name, cmd);
  }

  cached = {
    instructions: [localInstructions, ...compatInstructions].filter(Boolean).join("\n\n"),
    commands: Array.from(commandMap.values()),
    promptFiles: promptFiles.map((p) => ({ name: p.name, description: p.description })),
    agentFiles: compatAgents.map((p) => ({ name: p.name, description: p.description })),
  };
  return cached;
}

/** Watch .cvsuai/ and reload on change; calls onChange after each reload. */
export function watchCustomConfig(
  context: vscode.ExtensionContext,
  onChange: () => void
): void {
  const reload = async () => {
    await loadCustomConfig();
    onChange();
  };

  const patterns = [
    "**/.cvsuai/**",
    "**/*.prompt.md",
    "**/*.agent.md",
    "**/SKILL.md",
    "**/*.instructions.md",
    "**/copilot-instructions.md",
    "**/AGENTS.md",
  ];
  for (const pattern of patterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(reload);
    context.subscriptions.push(watcher);
  }
}

/** Prompt files (.prompt.md) exposed for quick run commands. */
export function getPromptFiles(): Array<{ name: string; description: string }> {
  return cached.promptFiles;
}

/** Agent files (.agent.md) exposed for quick run commands. */
export function getAgentFiles(): Array<{ name: string; description: string }> {
  return cached.agentFiles;
}

/** Scaffold a starter .cvsuai/ folder with examples. */
export async function scaffoldCustomConfig(): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage("CVSU AI DEV: open a folder first.");
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
