import * as vscode from "vscode";
import { ChatMessage } from "./client";

const STORE_KEY = "cvsuai.sessions";
const MAX_SESSIONS = 100;

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Lightweight entry for the history list (no message bodies). */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/**
 * Persists chat sessions in globalState so they survive reloads/restarts and
 * are visible across all workspaces.
 */
export class SessionStore {
  constructor(private readonly memento: vscode.Memento) {}

  private all(): Session[] {
    return this.memento.get<Session[]>(STORE_KEY, []);
  }

  private async saveAll(sessions: Session[]): Promise<void> {
    // Keep newest first, cap the count.
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    await this.memento.update(STORE_KEY, sessions.slice(0, MAX_SESSIONS));
  }

  list(): SessionSummary[] {
    return this.all()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.filter((m) => m.role === "user" || m.role === "assistant").length,
      }));
  }

  get(id: string): Session | undefined {
    return this.all().find((s) => s.id === id);
  }

  /** Most recently updated session, if any. */
  mostRecent(): Session | undefined {
    return this.all().sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  /** Insert or update a session (upsert by id). */
  async upsert(session: Session): Promise<void> {
    const sessions = this.all().filter((s) => s.id !== session.id);
    sessions.push(session);
    await this.saveAll(sessions);
  }

  async rename(id: string, title: string): Promise<void> {
    const sessions = this.all();
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    s.title = title.trim() || s.title;
    s.updatedAt = stamp();
    await this.saveAll(sessions);
  }

  async delete(id: string): Promise<void> {
    await this.saveAll(this.all().filter((s) => s.id !== id));
  }
}

/** Derive a short title from the first user message. */
export function titleFrom(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = (firstUser?.content ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "New chat";
  return text.length > 48 ? text.slice(0, 48) + "…" : text;
}

/**
 * Monotonic-ish timestamp. Date.now() is unavailable in some sandboxes; fall
 * back to a counter so ordering still works.
 */
let counter = 0;
export function stamp(): number {
  try {
    return Date.now();
  } catch {
    return ++counter;
  }
}

export function newId(): string {
  let s = "";
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 12; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
