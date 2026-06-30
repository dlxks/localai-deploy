import * as vscode from "vscode";

/**
 * The two AI targets the extension can talk to, and the logic for switching
 * between them + checking whether the LOCAL one is actually reachable.
 *
 * "Server" = the shared LocalAI LocalAI (slow, always assumed available).
 * "Local"  = a LocalAI instance running on this machine (fast, only available
 *            when the user has it running — so the toggle must reflect that).
 */

export function getServerUrl(): string {
  return vscode.workspace.getConfiguration("localai").get<string>("serverUrl") || "http://ai.cvsu.edu.ph";
}

export function getLocalUrl(): string {
  return vscode.workspace.getConfiguration("localai").get<string>("localUrl") || "http://localhost:8081";
}

export type Target = "server" | "local";

/** Which target is currently selected (derived from localai.baseUrl). */
export function currentTarget(): Target {
  const base = vscode.workspace
    .getConfiguration("localai")
    .get<string>("baseUrl", getServerUrl())
    .replace(/\/+$/, "");
  return isLocalUrl(base) ? "local" : "server";
}

function isLocalUrl(url: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url);
}

/** Point the extension at a target by updating localai.baseUrl globally. */
export async function setTarget(target: Target): Promise<void> {
  const url = target === "local" ? getLocalUrl() : getServerUrl();
  await vscode.workspace
    .getConfiguration("localai")
    .update("baseUrl", url, vscode.ConfigurationTarget.Global);
}

/**
 * Is the local instance up and serving? Hits /readyz with a short timeout.
 * Used to DISABLE switching-to-local when nothing is listening, and to warn
 * the user if their current local target has gone away.
 */
export async function isLocalReachable(timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${getLocalUrl()}/readyz`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
