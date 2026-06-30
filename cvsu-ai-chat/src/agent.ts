import * as vscode from "vscode";
import { ChatMessage, ToolCall, streamChatWithTools } from "./client";
import { ToolContext, findTool, toolDefs } from "./tools";

const SYSTEM_PROMPT = `You are CvSU-AI VSCode Chat, a coding agent embedded in VS Code.
You can use tools to read AND MODIFY files in the user's workspace.

CRITICAL — you ACT, you don't just suggest. And you NEVER blindly overwrite.

To call a tool, respond with ONLY a JSON object on its own:
  {"name": "<tool>", "arguments": { ... }}

PATHS — READ THIS FIRST:
- The system context above gives you the EXACT workspace-relative paths for the
  current file, its directory, and where to put a new test ("EXACT PATHS" block).
  USE THOSE PATHS VERBATIM. Do NOT invent paths.
- NEVER guess a path like "tests/test_x.py" unless the EXACT PATHS block told you
  to. The conventional test location is the SAME DIRECTORY as the source file
  (e.g. for a/b/c/foo.py -> a/b/c/test_foo.py), NOT a top-level "tests/" folder.
- NEVER pass an absolute path or an empty path to a tool.
- If you don't have the exact path, call list_files (no arguments) ONCE to get
  the real paths, then use one of them. Do not repeat a failed read_file.

MANDATORY workflow for creating/adding code (e.g. "create a unit test"):
1. Use the test path from the EXACT PATHS block above.
2. If that block says a test file ALREADY EXISTS -> call read_file on it FIRST,
   then ADD with append_to_file (preferred), or write_file with "overwrite": true
   and the FULL merged content. NEVER write_file an existing file without
   overwrite:true — it will be rejected.
3. If no test file exists -> call write_file with that exact path and the COMPLETE
   new file content.
4. After tools return, reply with a short plain-text summary of what you changed.

Rules:
- Pasting code in chat without calling a tool is a FAILURE — apply it.
- Do not invent file contents — read existing files before modifying them.
- The user's open file contents are already provided above; you do NOT need
  read_file for it. If the target test file's contents are ALSO provided above
  (look for "ALREADY EXISTS … contents are below"), you do NOT need read_file for
  it either — call append_to_file directly. Only call read_file for files whose
  contents are NOT already shown to you.

Tools: read_file, list_files, search, write_file (overwrite-guarded),
append_to_file. The user approves every write, so just make the call.`;

export interface AgentEvents {
  /** Called as the model streams text for the current step. */
  onToken: (delta: string) => void;
  /** Marks the start of a new assistant step (so the UI can open a fresh bubble). */
  onStepStart: () => void;
  onAssistantText: (text: string) => void;
  onToolStart: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string) => void;
  onStatus: (status: string) => void;
}

/**
 * Run the agent loop: ask the model, run any tools it requests, feed the
 * results back, and repeat until it returns a plain text answer or we hit the
 * iteration cap.
 */
export async function runAgent(
  secrets: vscode.SecretStorage,
  history: ChatMessage[],
  events: AgentEvents,
  toolCtx: ToolContext,
  signal: AbortSignal,
  contextText = "",
  /** Extra instructions from a custom agent or project instructions file. */
  extraSystem = ""
): Promise<void> {
  const maxIters = vscode.workspace.getConfiguration("localai").get<number>("agent.maxIterations") ?? 8;

  // Lead with the agent system prompt + any custom agent/project instructions +
  // this turn's editor context (all transient), then the persisted conversation.
  // New assistant/tool turns are appended to `history` so follow-ups keep context.
  const lead: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  if (extraSystem) lead.push({ role: "system", content: extraSystem });
  if (contextText) lead.push({ role: "system", content: contextText });
  const messages: ChatMessage[] = [...lead, ...history];

  // Loop detection: remember recent (tool,args) signatures so we can break out
  // when the model repeats the same call — usually because a path keeps failing.
  const recentCalls: string[] = [];
  const sig = (c: ToolCall) => `${c.name}(${JSON.stringify(c.arguments)})`;
  let nudged = false;
  // Files already read this turn — re-reading is the #1 way weak models loop, so
  // we short-circuit a repeat read into a "you already have it, now write" push.
  const readPaths = new Set<string>();

  for (let iter = 0; iter < maxIters; iter++) {
    if (signal.aborted) return;
    events.onStatus(`Working… (step ${iter + 1}/${maxIters})`);
    events.onStepStart();

    // Stream this step so the UI shows tokens live instead of hanging.
    const turn = await streamChatWithTools(
      secrets,
      messages,
      toolDefs(),
      (delta) => events.onToken(delta),
      signal
    );

    if (turn.toolCalls.length === 0) {
      // Final answer (already streamed via onToken; this finalizes the bubble).
      events.onStatus("");
      events.onAssistantText(turn.content || "");
      // Persist to durable history (not the transient lead) for follow-up turns.
      history.push({ role: "assistant", content: turn.content });
      return;
    }

    // --- loop detection ---
    // How many of this turn's calls exactly repeat a recent call?
    const repeats = turn.toolCalls.filter((c) => recentCalls.includes(sig(c)));
    for (const c of turn.toolCalls) recentCalls.push(sig(c));
    // Keep the window small (last ~6 calls).
    while (recentCalls.length > 6) recentCalls.shift();

    if (repeats.length === turn.toolCalls.length && repeats.length > 0) {
      // Distinguish two loops: (a) re-reading a file it ALREADY read successfully
      // (the model is stuck deciding to write), vs (b) re-calling a FAILED lookup
      // (it's guessing a bad path). They need different nudges.
      const allRereads = turn.toolCalls.every(
        (c) => c.name === "read_file" && readPaths.has(String(c.arguments?.path ?? ""))
      );
      if (!nudged) {
        nudged = true;
        messages.push({
          role: "system",
          content: allRereads
            ? "You already read that file — its contents are above. STOP reading it. " +
              "Now APPLY the change: call append_to_file to add your new tests, or " +
              "write_file with \"overwrite\": true and the complete merged content. " +
              "If you are finished, reply with a short plain-text summary instead."
            : "You are repeating the same tool call that already failed. STOP guessing. " +
              "Call list_files (no arguments) to get the EXACT workspace-relative paths, " +
              "then use one of those paths verbatim. Do not pass absolute paths.",
        });
        continue; // re-ask without executing the duplicate calls
      }
      // Still looping after the nudge — stop with advice tailored to the cause.
      events.onStatus("");
      events.onAssistantText(
        allRereads
          ? "I read the file but couldn't reliably apply the edit with this model. " +
            "Two reliable options: switch the model (bottom dropdown) to the **7B** — " +
            "it's much better at edits — and try again, or click **Apply** on the code " +
            "block above to write it to a file directly."
          : "I got stuck repeating the same file lookup, so I stopped to avoid looping. " +
            "The path I tried doesn't resolve in the open workspace. Please confirm the " +
            "file's location, or open the folder that contains it, and I'll continue."
      );
      return;
    }

    // Record the assistant's tool-call turn (request payload + durable history).
    const assistantTurn: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: turn.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
    messages.push(assistantTurn);
    history.push(assistantTurn);

    // Execute each requested tool and append results.
    for (const call of turn.toolCalls) {
      if (signal.aborted) return;

      // If the model re-reads a file it already read this turn, don't re-read —
      // push it to act. Weak local models otherwise read in circles forever.
      let result: string;
      const reReadPath =
        call.name === "read_file" ? String(call.arguments?.path ?? "") : "";
      if (reReadPath && readPaths.has(reReadPath)) {
        events.onStatus("");
        result =
          `You ALREADY read "${reReadPath}" earlier this turn — its contents are above. ` +
          `Do NOT read it again. Now make the change: call append_to_file to ADD ` +
          `your new tests to it, or write_file with "overwrite": true and the full ` +
          `merged content. If you are done, reply with a short plain-text summary.`;
      } else {
        result = await executeTool(call, events, toolCtx);
        // Only remember reads that actually returned file contents (not errors).
        if (reReadPath && !result.startsWith("Error:")) readPaths.add(reReadPath);
      }

      const toolTurn: ChatMessage = {
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content: result,
      };
      messages.push(toolTurn);
      history.push(toolTurn);
    }
  }

  events.onStatus("");
  events.onAssistantText(
    `Reached the ${maxIters}-step limit without finishing. You can raise "localai.agent.maxIterations" or ask me to continue.`
  );
}

async function executeTool(
  call: ToolCall,
  events: AgentEvents,
  toolCtx: ToolContext
): Promise<string> {
  events.onToolStart(call.name, call.arguments);
  const tool = findTool(call.name);
  if (!tool) {
    const msg = `Unknown tool: ${call.name}`;
    events.onToolResult(call.name, msg);
    return msg;
  }
  try {
    const result = await tool.run(call.arguments, toolCtx);
    events.onToolResult(call.name, result);
    return result;
  } catch (err: any) {
    const msg = `Error: ${err?.message ?? String(err)}`;
    events.onToolResult(call.name, msg);
    return msg;
  }
}
