import * as vscode from "vscode";
import { currentTarget } from "./endpoints";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant turns that requested tools. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** Present on tool-result turns; links back to the assistant's tool_call id. */
  tool_call_id?: string;
  /** Tool name on tool-result turns (some servers want it). */
  name?: string;
}

/** OpenAI-style tool definition sent to the model. */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

const SERVER_COOKIE_SECRET_KEY = "localai.serverSessionCookie";
const LOCAL_COOKIE_SECRET_KEY = "localai.localSessionCookie";
const SERVER_APIKEY_SECRET_KEY = "localai.serverApiKey";
const LOCAL_APIKEY_SECRET_KEY = "localai.localApiKey";

export function getApiKeySecretKey(): string {
  return currentTarget() === "local" ? LOCAL_APIKEY_SECRET_KEY : SERVER_APIKEY_SECRET_KEY;
}

export function getCookieSecretKey(): string {
  return currentTarget() === "local" ? LOCAL_COOKIE_SECRET_KEY : SERVER_COOKIE_SECRET_KEY;
}

/** Read the configured base URL, normalized (no trailing slash, no /v1). */
export function getBaseUrl(): string {
  const cfg = vscode.workspace.getConfiguration("localai");
  const fromSettings = cfg.get<string>("baseUrl");
  const base = fromSettings || process.env.LOCALAI_BASE_URL || "http://localhost:8081";
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function getModel(): string {
  const cfg = vscode.workspace.getConfiguration("localai");
  const fromSettings = cfg.get<string>("model");
  return fromSettings || process.env.LOCALAI_MODEL || "qwen2.5-coder-7b-instruct-q8_0.gguf";
}

export function getAgentModel(): string {
  return getModel();
}

/**
 * Cap on the model's reply length. The single biggest "feels faster" lever:
 * generation time scales with tokens produced, so a smaller cap = a faster reply.
 * 0 (or unset) means "no cap" — let the server decide. Returned as a value
 * suitable for the request body, or undefined to omit `max_tokens` entirely.
 */
export function getMaxTokens(): number | undefined {
  const cfg = vscode.workspace.getConfiguration("localai");
  const n = cfg.get<number>("maxTokens") ?? 0;
  return n && n > 0 ? n : undefined;
}

/** Add `max_tokens` to a request body only when a cap is configured. */
function withMaxTokens<T extends Record<string, unknown>>(body: T): T {
  const max = getMaxTokens();
  return max ? { ...body, max_tokens: max } : body;
}

/**
 * Resolve the active API key, in priority order:
 *   1. SecretStorage (set via Sign In / Enter API Key) — the durable, per-user credential.
 *   2. process.env.LOCALAI_API_KEY — dev-only, seeded from .env in the Extension
 *      Development Host. Never present in a packaged .vsix.
 */
async function resolveApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return (await secrets.get(getApiKeySecretKey())) || process.env.LOCALAI_API_KEY || undefined;
}

/**
 * Build auth headers. The server accepts a Bearer key OR a session cookie;
 * we send exactly ONE (key wins) so the server never has to pick.
 */
async function authHeaders(secrets: vscode.SecretStorage): Promise<Record<string, string>> {
  const apiKey = await resolveApiKey(secrets);
  if (apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  }
  const cookie = await secrets.get(getCookieSecretKey());
  if (cookie) {
    return { Cookie: cookie.includes("=") ? cookie : `session=${cookie}` };
  }
  return {};
}

export async function setApiKey(secrets: vscode.SecretStorage, value: string): Promise<void> {
  await secrets.store(getApiKeySecretKey(), value.trim());
}

export async function setSessionCookie(secrets: vscode.SecretStorage, value: string): Promise<void> {
  await secrets.store(getCookieSecretKey(), value.trim());
}

/** Clear the stored credentials (sign out) for the current target. */
export async function clearCredentials(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(getApiKeySecretKey());
  await secrets.delete(getCookieSecretKey());
}

export async function hasCredentials(secrets: vscode.SecretStorage): Promise<boolean> {
  if (await resolveApiKey(secrets)) return true;
  return Boolean(await secrets.get(getCookieSecretKey()));
}

async function handleResponseError(res: Response, secrets: vscode.SecretStorage): Promise<never> {
  const body = (await res.text()).slice(0, 300);
  if (res.status === 401 || res.status === 403) {
    vscode.window.showWarningMessage(
      `AI Chat authentication failed (${res.status}). Your session expired or the API key is invalid. You have been signed out.`
    );
    await clearCredentials(secrets);
    void vscode.commands.executeCommand("cvsuai.refreshUI");
  }
  throw new Error(`${res.status} ${res.statusText}: ${body}`);
}

/**
 * Model used for embeddings (RAG). Defaults to a dedicated embedding model
 * ("nomic-embed-text-v1.5") — coder/generation models crash when asked to embed
 * (they aren't loaded in embedding mode). Override via localai.rag.embeddingModel.
 */
export function getEmbeddingModel(): string {
  const cfg = vscode.workspace.getConfiguration("localai");
  const fromSettings = cfg.get<string>("rag.embeddingModel");
  return fromSettings || "nomic-embed-text-v1.5";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : ""))
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function inferModelId(row: any): string {
  return String(row?.id ?? row?.name ?? row?.model ?? row?.model_id ?? "").trim();
}

function isEmbeddingRow(row: any): boolean {
  if (!row || typeof row !== "object") return false;
  if (row.embeddings === true || row.embedding === true) return true;
  const cfg = row.config && typeof row.config === "object" ? row.config : undefined;
  if (cfg?.embeddings === true || cfg?.embedding === true) return true;
  const caps = asStringArray(row.capabilities).concat(asStringArray(row.usecases)).concat(asStringArray(row.known_usecases));
  return caps.some((c) => c.includes("embed"));
}

/**
 * List only installed models that support embeddings.
 *
 * Preferred source is /api/models because it exposes capability metadata.
 * If unavailable on a given server build, falls back to /v1/models and keeps
 * only IDs that look like embedding models.
 */
export async function listEmbeddingModels(secrets: vscode.SecretStorage): Promise<string[]> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/models`, {
      headers: { ...(await authHeaders(secrets)), Origin: getBaseUrl() },
    });
    if (res.ok) {
      const json = (await res.json()) as any;
      const rows: any[] = Array.isArray(json)
        ? json
        : Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.models)
        ? json.models
        : [];
      const ids = rows
        .filter((row) => isEmbeddingRow(row))
        .map((row) => inferModelId(row))
        .filter(Boolean);
      return Array.from(new Set(ids)).sort();
    }
  } catch {
    // Fall through to compatibility fallback.
  }

  const ids = await listModels(secrets);
  return ids.filter((id) => /embed(ding)?/i.test(id));
}

/**
 * Embed a batch of strings via POST /v1/embeddings. Returns one vector per
 * input, in the same order. Used by the RAG index/retrieval.
 */
export async function embeddings(
  secrets: vscode.SecretStorage,
  inputs: string[],
  signal?: AbortSignal
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const res = await fetch(`${getBaseUrl()}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: getBaseUrl(),
      ...(await authHeaders(secrets)),
    },
    body: JSON.stringify({ model: getEmbeddingModel(), input: inputs }),
    signal,
  });
  if (!res.ok) await handleResponseError(res, secrets);
  const json = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
  const data = json.data ?? [];
  // Preserve input order (some servers return an out-of-order index field).
  const ordered = data.every((d) => typeof d.index === "number")
    ? [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    : data;
  return ordered.map((d) => d.embedding);
}

/** List model IDs from GET /v1/models. */
export async function listModels(secrets: vscode.SecretStorage): Promise<string[]> {
  const res = await fetch(`${getBaseUrl()}/v1/models`, {
    headers: { ...(await authHeaders(secrets)), Origin: getBaseUrl() },
  });
  if (!res.ok) await handleResponseError(res, secrets);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => m.id).sort();
}

/**
 * Truncate a long string to `max` chars, keeping the head and tail (the parts
 * that usually matter — signatures up top, the edit point near the end) and
 * marking the cut. Returns the string unchanged if it already fits.
 */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const marker = "\n…[truncated to fit the context window]…\n";
  if (max <= marker.length) return s.slice(0, Math.max(0, max));
  const keep = max - marker.length;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return s.slice(0, head) + marker + s.slice(s.length - tail);
}

/**
 * Trim a message list so the request is GUARANTEED to fit the server's context
 * window — no matter how large any single message (a huge embedded file, a big
 * read_file result) is. The previous version trimmed only the conversation tail
 * and left the leading system messages (system prompt + per-turn file context)
 * untouched, AND kept the newest message even when it alone exceeded the budget
 * — so a /refactor on a large file overflowed with "exceeds context size".
 *
 * Strategy:
 *   - input budget = contextSize − reply reserve − a safety margin (the ~4
 *     chars/token estimate is optimistic for dense code/markdown);
 *   - the leading system messages get up to 60% of that budget and are
 *     TRUNCATED to fit (never sent whole);
 *   - the most-recent conversation turns fill the rest; if the single newest
 *     turn is itself too big, it's truncated rather than dropped or sent whole.
 * The returned messages' total length is always ≤ the input budget.
 */
function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  const cfg = vscode.workspace.getConfiguration("localai");
  const ctxTokens = cfg.get<number>("contextSize") ?? 4096;
  const replyTokens = cfg.get<number>("maxTokens") || 1024; // reserve for output
  // Safety margin: char→token estimation undercounts for dense content, so leave
  // headroom beyond the reply reserve to avoid tipping just over the window.
  const safety = Math.max(256, Math.floor(ctxTokens * 0.05));
  const inputTokens = Math.max(512, ctxTokens - replyTokens - safety);
  const MAX_INPUT_CHARS = inputTokens * 4; // ~4 chars/token

  const leadCount = messages.findIndex((m) => m.role !== "system");
  const lead = leadCount === -1 ? messages.slice() : messages.slice(0, leadCount);
  const rest = leadCount === -1 ? [] : messages.slice(leadCount);

  // 1. Leading system messages: cap the TOTAL so a big embedded file/context
  //    can't consume the whole window. Truncate the message that overruns.
  const LEAD_BUDGET = Math.floor(MAX_INPUT_CHARS * 0.6);
  const keptLead: ChatMessage[] = [];
  let leadUsed = 0;
  for (const m of lead) {
    const remaining = LEAD_BUDGET - leadUsed;
    if (remaining <= 0) break;
    const content = m.content ?? "";
    if (content.length <= remaining) {
      keptLead.push(m);
      leadUsed += content.length;
    } else {
      keptLead.push({ ...m, content: truncateMiddle(content, remaining) });
      leadUsed = LEAD_BUDGET;
      break;
    }
  }

  // 2. Fill the remaining budget with the most-recent conversation turns.
  let budget = MAX_INPUT_CHARS - leadUsed;
  const keptRest: ChatMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    if (budget <= 0) break;
    const content = rest[i].content ?? "";
    if (content.length <= budget) {
      keptRest.unshift(rest[i]);
      budget -= content.length;
    } else if (keptRest.length === 0) {
      // The newest turn alone exceeds the budget — truncate it (don't drop it,
      // don't send it whole), so the request stays within the window.
      keptRest.unshift({ ...rest[i], content: truncateMiddle(content, budget) });
      budget = 0;
    } else {
      break; // older turns: stop at the first one that no longer fits
    }
  }

  return [...keptLead, ...keptRest];
}

/** Tokens reserved for the summary reply. Callers must size the input they send
 *  to summarize() so that (input + this + prompt overhead) fits the context
 *  window — otherwise the request is rejected with "exceeds context size". */
export const SUMMARY_MAX_TOKENS = 700;

/**
 * One-shot (non-streaming) completion that summarizes a block of conversation
 * text into a compact form, used by auto-compaction. Returns the summary string.
 * Bypasses trimMessages on purpose — we send exactly what we want summarized,
 * so the CALLER is responsible for clipping the input to fit the context window.
 */
export async function summarize(
  secrets: vscode.SecretStorage,
  conversationText: string,
  signal?: AbortSignal
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You compress conversations. Output a CONCISE summary that preserves the " +
        "important facts, decisions, code snippets, file paths, and any open " +
        "questions or tasks. Use terse bullet points. No preamble, no closing remarks.",
    },
    {
      role: "user",
      content:
        "Summarize the following conversation so the summary can REPLACE the " +
        "original messages while keeping all context needed to continue:\n\n" +
        conversationText,
    },
  ];
  const res = await fetch(`${getBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: getBaseUrl(),
      ...(await authHeaders(secrets)),
    },
    body: JSON.stringify({ model: getModel(), messages, stream: false, max_tokens: SUMMARY_MAX_TOKENS }),
    signal,
  });
  if (!res.ok) await handleResponseError(res, secrets);
  const json = (await res.json()) as any;
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

/**
 * Stream a chat completion via POST /v1/chat/completions (SSE).
 * Calls onToken for each content delta. Returns when the stream ends.
 */
export async function streamChat(
  secrets: vscode.SecretStorage,
  messages: ChatMessage[],
  onToken: (delta: string) => void,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: getBaseUrl(),
      ...(await authHeaders(secrets)),
    },
    body: JSON.stringify(withMaxTokens({ model: getModel(), messages: trimMessages(messages), stream: true })),
    signal,
  });

  if (!res.ok) await handleResponseError(res, secrets);
  if (!res.body) {
    throw new Error("No response body from server.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by blank lines; each "data:" line is one event.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (delta) onToken(delta);
      } catch {
        // partial JSON across chunk boundaries — ignore; next read completes it
      }
    }
  }
}

export interface ChatTurnResult {
  content: string;
  toolCalls: ToolCall[];
  raw: any;
}

/**
 * Non-streaming chat used by the agent loop. Sends the tool definitions and
 * returns either assistant text or the tool calls it wants to make.
 *
 * This LocalAI instance often returns a function call as JSON text in `content`
 * instead of the structured `tool_calls` field, so we extract from both.
 */
export async function chatWithTools(
  secrets: vscode.SecretStorage,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal
): Promise<ChatTurnResult> {
  const res = await fetch(`${getBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: getBaseUrl(),
      ...(await authHeaders(secrets)),
    },
    body: JSON.stringify(withMaxTokens({
      model: getAgentModel(),
      messages: trimMessages(messages),
      tools,
      tool_choice: "auto",
      stream: false,
    })),
    signal,
  });

  if (!res.ok) await handleResponseError(res, secrets);

  const json = (await res.json()) as any;
  const message = json?.choices?.[0]?.message ?? {};
  const content: string = typeof message.content === "string" ? message.content : "";

  const toolCalls = extractToolCalls(message, content);
  return { content: toolCalls.length ? "" : content, toolCalls, raw: json };
}

/**
 * Streaming variant of chatWithTools used by the agent loop so the UI shows
 * tokens as they arrive instead of hanging on a blocking request.
 *
 * Streams text via onToken, accumulates any structured tool_calls deltas, and
 * at the end resolves the tool calls (structured first, else parsed from the
 * accumulated content — LocalAI streams tool calls as JSON text).
 */
export async function streamChatWithTools(
  secrets: vscode.SecretStorage,
  messages: ChatMessage[],
  tools: ToolDef[],
  onToken: (delta: string) => void,
  signal: AbortSignal
): Promise<ChatTurnResult> {
  const res = await fetch(`${getBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: getBaseUrl(),
      ...(await authHeaders(secrets)),
    },
    body: JSON.stringify(withMaxTokens({ model: getAgentModel(), messages: trimMessages(messages), tools, tool_choice: "auto", stream: true })),
    signal,
  });

  if (!res.ok) await handleResponseError(res, secrets);
  if (!res.body) throw new Error("No response body from server.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  // Gate UI streaming: this LocalAI model often emits a tool call as plain JSON
  // in `content`. We must NOT show that JSON to the user. So we hold back tokens
  // while the accumulated content still *could* be a tool-call JSON, and only
  // flush to the UI once we're confident it's prose (gateDecided + !suppress).
  let emitted = 0; // chars of `content` already sent to the UI
  let gateDecided = false;
  let suppress = false;
  const flushVisible = () => {
    if (suppress) return;
    if (content.length > emitted) {
      onToken(content.slice(emitted));
      emitted = content.length;
    }
  };
  // Accumulate structured tool_calls deltas by index.
  const toolAcc: Record<number, { id?: string; name: string; args: string }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk?.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          if (!gateDecided) {
            const verdict = looksLikeToolCall(content);
            if (verdict === "yes") {
              gateDecided = true;
              suppress = true; // it's a tool call — never show it
            } else if (verdict === "no") {
              gateDecided = true;
              suppress = false;
              flushVisible(); // confirmed prose — release what we held
            }
            // verdict === "maybe": keep buffering, emit nothing yet
          } else {
            flushVisible();
          }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            toolAcc[idx] ??= { name: "", args: "" };
            if (tc.id) toolAcc[idx].id = tc.id;
            if (tc.function?.name) toolAcc[idx].name += tc.function.name;
            if (tc.function?.arguments) toolAcc[idx].args += tc.function.arguments;
          }
        }
      } catch {
        // partial JSON across chunk boundaries — next read completes it
      }
    }
  }

  // Resolve tool calls: structured deltas first, else parse from content.
  const structured = Object.values(toolAcc).filter((t) => t.name);
  let toolCalls: ToolCall[];
  if (structured.length > 0) {
    toolCalls = structured.map((t, i) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(t.args || "{}");
      } catch {
        args = {};
      }
      return { id: t.id ?? `call_${i}`, name: t.name, arguments: args };
    });
  } else {
    toolCalls = parseToolCallsFromContent(content);
  }

  // End-of-stream reconciliation:
  //  - If it WAS a tool call, make sure nothing leaked (it was suppressed).
  //  - If we held tokens but it turned out NOT to be a tool call, flush them now.
  if (toolCalls.length === 0 && !suppress && emitted < content.length) {
    onToken(content.slice(emitted));
    emitted = content.length;
  }

  return { content: toolCalls.length ? "" : content, toolCalls, raw: null };
}

/**
 * Pull tool calls from a response, supporting two shapes:
 *  1) OpenAI-standard `message.tool_calls[]`.
 *  2) LocalAI fallback: the call serialized as JSON in `message.content`,
 *     e.g.  {"name":"read_file","arguments":{"path":"a.ts"}}
 *     (sometimes with a stray leading brace, multiple objects, or ```json fences).
 */
function extractToolCalls(message: any, content: string): ToolCall[] {
  // Shape 1: structured tool_calls.
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls.map((tc: any, i: number) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc?.function?.arguments ?? "{}");
      } catch {
        args = {};
      }
      return { id: tc.id ?? `call_${i}`, name: tc?.function?.name ?? "", arguments: args };
    });
  }

  // Shape 2: parse function-call JSON out of content.
  return parseToolCallsFromContent(content);
}

/**
 * Decide, mid-stream, whether the accumulated content is becoming a tool-call
 * JSON (which we must hide from the UI) or ordinary prose (which we show).
 *
 *   "yes"   — it parses as / clearly is a tool call: suppress it.
 *   "no"    — it's prose (doesn't start like JSON, or starts with prose text).
 *   "maybe" — still ambiguous (e.g. just "{" so far): keep buffering.
 *
 * The model emits calls like {"name":"read_file","arguments":{...}} sometimes
 * wrapped in ```json fences. We treat a leading "{" or fence as "maybe" until we
 * see enough to confirm, so the very first tokens never flash on screen.
 */
function looksLikeToolCall(raw: string): "yes" | "no" | "maybe" {
  const s = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trimStart();
  if (!s) return "maybe";
  // Prose: first non-space char isn't a brace -> definitely not a tool call.
  if (s[0] !== "{") return "no";
  // Starts with "{". If we can already see the tell-tale keys, confirm.
  if (/"name"\s*:/.test(s) && /"arguments"\s*:/.test(s)) return "yes";
  // A complete object that parses with name+arguments is a yes.
  if (parseToolCallsFromContent(s).length > 0) return "yes";
  // Looks like the start of some other JSON object the model is "thinking" in,
  // but not yet a recognizable tool call. If it's grown long without the keys,
  // give up suppressing (show it) so real JSON answers aren't hidden forever.
  if (s.length > 200) return "no";
  return "maybe";
}

/** Best-effort recovery of {"name","arguments"} objects from free-form content. */
export function parseToolCallsFromContent(content: string): ToolCall[] {
  if (!content) return [];
  // Strip code fences and a common stray leading "{".
  const cleaned = content
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const calls: ToolCall[] = [];
  // Scan for balanced top-level JSON objects.
  for (const objText of extractJsonObjects(cleaned)) {
    try {
      const obj = JSON.parse(objText);
      if (obj && typeof obj.name === "string" && obj.arguments && typeof obj.arguments === "object") {
        calls.push({
          id: `call_${calls.length}`,
          name: obj.name,
          arguments: obj.arguments as Record<string, unknown>,
        });
      }
    } catch {
      // not valid JSON — skip
    }
  }
  return calls;
}

/** Yield substrings that look like complete, brace-balanced JSON objects. */
function extractJsonObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0; // recover from a stray closing brace
      }
    }
  }
  return out;
}
