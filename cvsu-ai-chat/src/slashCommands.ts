/**
 * Slash commands turn common requests into one click and wrap them in
 * well-engineered prompts. The editor context (selection / open file) is
 * attached separately by context.ts, so these prompts can refer to "the code
 * above" / "the provided file".
 */

export interface SlashCommand {
  name: string; // without the leading slash
  description: string;
  /** Whether this command works best in agent mode (writes files). */
  prefersAgent: boolean;
  /**
   * Build the prompt sent to the model. `arg` is any text the user typed after
   * the command (e.g. "/fix make it handle nulls" -> arg = "make it handle nulls").
   */
  buildPrompt: (arg: string) => string;
  /** Custom agents only: an extra system prompt defining the agent's behavior. */
  systemPrompt?: string;
  /** Optional allow-list of tools for agent turns. */
  allowedTools?: string[];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "explain",
    description: "Explain the selected code / open file",
    prefersAgent: false,
    buildPrompt: (arg) =>
      `Explain the provided code clearly and concisely. Cover what it does, the ` +
      `key logic, and any non-obvious behavior or edge cases. ${focus(arg)}`,
  },
  {
    name: "test",
    description: "Write unit tests for the code",
    prefersAgent: true,
    buildPrompt: (arg) =>
      `Write thorough unit tests for the provided code. Cover the happy path, ` +
      `edge cases, and error conditions. Match the project's existing test style ` +
      `and framework. If a test file already exists for this code, ADD to it ` +
      `rather than replacing it. ${focus(arg)}`,
  },
  {
    name: "fix",
    description: "Find and fix bugs in the code",
    prefersAgent: true,
    buildPrompt: (arg) =>
      `Review the provided code for bugs and correctness issues, then fix them. ` +
      `Explain each problem briefly before the fix. Keep changes minimal and ` +
      `preserve existing behavior that is correct. ${focus(arg)}`,
  },
  {
    name: "review",
    description: "Code review: bugs, smells, improvements",
    prefersAgent: false,
    buildPrompt: (arg) =>
      `Do a focused code review of the provided code. List concrete findings ` +
      `(correctness bugs first, then clarity/maintainability), each with a short ` +
      `rationale and a suggested change. Be specific; skip generic advice. ${focus(arg)}`,
  },
  {
    name: "doc",
    description: "Add docstrings / comments",
    prefersAgent: true,
    buildPrompt: (arg) =>
      `Add clear docstrings/comments to the provided code following the ` +
      `language's conventions (e.g. Python docstrings, JSDoc). Document parameters, ` +
      `returns, and non-obvious logic. Do not change the code's behavior. ${focus(arg)}`,
  },
  {
    name: "refactor",
    description: "Refactor for clarity without changing behavior",
    prefersAgent: true,
    buildPrompt: (arg) =>
      `Refactor the provided code to improve readability and structure WITHOUT ` +
      `changing its observable behavior. Explain the key changes. ${focus(arg)}`,
  },
  {
    name: "ask",
    description: "Ask a free-form question about the code",
    prefersAgent: false,
    buildPrompt: (arg) =>
      arg ? arg : "Answer the user's question about the provided code.",
  },
  {
    // codebase: RAG-augmented. chatPanel detects command==="codebase" and
    // attaches semantically-retrieved chunks from the indexed workspace.
    name: "codebase",
    description: "Ask about the whole codebase (semantic search / RAG)",
    prefersAgent: false,
    buildPrompt: (arg) =>
      arg
        ? `Using the retrieved workspace code below, answer: ${arg}`
        : "Answer the user's question using the retrieved workspace code below.",
  },
  {
    // stop: control command handled by chatPanel; no model call should happen.
    name: "stop",
    description: "Stop/cancel the current AI response",
    prefersAgent: false,
    buildPrompt: () => "",
  },
  {
    // caveman (github.com/JuliusBrussee/caveman): answer in terse "caveman" style
    // to cut output tokens (~75%) while keeping full technical accuracy.
    name: "caveman",
    description: "Answer ultra-tersely (caveman style — few words, full accuracy)",
    prefersAgent: false,
    buildPrompt: (arg) =>
      `Answer in CAVEMAN STYLE: as few words as possible, no filler, no pleasantries, ` +
      `no hedging — but keep full technical accuracy and any critical caveats. Drop ` +
      `articles and "to be" verbs. Use short fragments. Code blocks stay normal and correct. ` +
      `"Why use many token when few do trick." ${question(arg)}`,
  },
  {
    // ponytail (github.com/DietrichGebert/ponytail): the "lazy senior dev" —
    // write the least code that fully solves the task, never cutting safety.
    name: "ponytail",
    description: "Solve with the least code (lazy-senior-dev minimalism)",
    prefersAgent: false,
    buildPrompt: (arg) =>
      `Act like a lazy senior developer: produce the MINIMUM code that fully solves ` +
      `the task. Before writing code, climb this ladder and stop at the first rung ` +
      `that holds: (1) Does this need to exist at all? — if not, skip it (YAGNI). ` +
      `(2) Already in this codebase? reuse it. (3) Standard library does it? use it. ` +
      `(4) Native platform feature? use it. (5) An installed dependency? use it. ` +
      `(6) One line? one line. (7) Only then: the minimum that works. ` +
      `NEVER cut input/trust-boundary validation, error handling, security, or ` +
      `accessibility — small because necessary, not golfed. Briefly say which rung ` +
      `you stopped at and why. ${question(arg)}`,
  },
];

function focus(arg: string): string {
  return arg ? `Specifically: ${arg}` : "";
}

/** For style commands: the user's actual request, or a default to use the context. */
function question(arg: string): string {
  return arg
    ? `The user's request: ${arg}`
    : "Apply this to the user's question / the provided code.";
}

/**
 * User-defined commands (from .cvsuai/skills and .cvsuai/agents) registered at
 * runtime. They extend the built-in list and appear in the / menu. Custom agents
 * carry a `systemPrompt` and run in agent mode.
 */
let customCommands: SlashCommand[] = [];

export function setCustomCommands(
  cmds: Array<{
    name: string;
    description: string;
    body: string;
    isAgent: boolean;
    isPromptFile?: boolean;
    allowedTools?: string[];
  }>
): void {
  customCommands = cmds.map((c) => ({
    name: c.name,
    description: c.description,
    prefersAgent: c.isAgent,
    // Agents: the body is their system prompt; the user's text is the task.
    // Skills: the body is a prompt template with $ARGUMENTS substituted.
    buildPrompt: (arg: string) => {
      // Prompt files are user prompts (even when they prefer agent mode).
      if (c.isPromptFile) {
        return c.body.includes("$ARGUMENTS")
          ? c.body.replace(/\$ARGUMENTS/g, arg).trim()
          : arg
          ? `${c.body.trim()}\n\nUser arguments: ${arg}`
          : c.body.trim();
      }

      // Custom agents use systemPrompt as behavior and user text as task.
      if (c.isAgent) {
        return arg || "Proceed with the user's request using the provided context.";
      }

      return c.body.includes("$ARGUMENTS")
        ? c.body.replace(/\$ARGUMENTS/g, arg).trim()
        : arg
        ? `${c.body.trim()}\n\nUser arguments: ${arg}`
        : c.body.trim();
    },
    systemPrompt: c.isAgent && !c.isPromptFile ? c.body : undefined,
    allowedTools: c.allowedTools,
  }));
}

/** All commands the user can invoke: built-in first, then custom (custom wins on name clash). */
export function allSlashCommands(): SlashCommand[] {
  const customNames = new Set(customCommands.map((c) => c.name));
  return [...SLASH_COMMANDS.filter((c) => !customNames.has(c.name)), ...customCommands];
}

export function findSlashCommand(name: string): SlashCommand | undefined {
  return allSlashCommands().find((c) => c.name === name.toLowerCase());
}

/**
 * Parse a chat input. If it starts with a known /command, return the expanded
 * prompt, whether agent mode is recommended, and any custom-agent system prompt.
 * Otherwise return null.
 */
export function parseSlash(
  input: string
): {
  prompt: string;
  prefersAgent: boolean;
  command: string;
  systemPrompt?: string;
  allowedTools?: string[];
} | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([\w-]+)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  const cmd = findSlashCommand(match[1]);
  if (!cmd) return null;
  return {
    prompt: cmd.buildPrompt(match[2].trim()),
    prefersAgent: cmd.prefersAgent,
    command: cmd.name,
    systemPrompt: cmd.systemPrompt,
    allowedTools: cmd.allowedTools,
  };
}
