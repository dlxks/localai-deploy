import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Developer convenience: in the Extension Development Host only, load a `.env`
 * from the extension root into process.env (without overwriting existing vars).
 *
 * This NEVER runs for colleagues installing the packaged .vsix:
 *  - the .vsix excludes .env (.vscodeignore), so the file isn't there, and
 *  - we gate on ExtensionMode.Development regardless.
 *
 * Recognized keys: LOCALAI_BASE_URL, LOCALAI_API_KEY, LOCALAI_MODEL.
 */
export function loadDevEnv(context: vscode.ExtensionContext): void {
  if (context.extensionMode !== vscode.ExtensionMode.Development) return;

  const envPath = path.join(context.extensionPath, ".env");
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // no .env — nothing to do
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
