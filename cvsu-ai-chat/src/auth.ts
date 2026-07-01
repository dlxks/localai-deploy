import * as vscode from "vscode";
import { currentTarget } from "./endpoints";
import {
  getBaseUrl,
  setApiKey,
  setSessionCookie,
  clearCredentials,
  hasCredentials,
  listModels,
} from "./client";



/**
 * Sign-in entry point. Offers two paths:
 *   1. Enter API Key — paste a `lai-...` key directly (the durable credential).
 *   2. Sign in with GitHub — open the browser login, then paste a key (or cookie) back.
 *
 * True in-VS-Code OAuth is impossible here: the server's OAuth redirect_uri is
 * hard-wired to its own /api/auth/github/callback, so the extension can neither
 * be the redirect target nor read the session cookie set in the external
 * browser. GitHub login therefore = "log in via browser, bring a credential back".
 *
 * Returns true if credentials were stored and validated.
 */
export async function signIn(secrets: vscode.SecretStorage): Promise<boolean> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "$(key) Enter API Key", id: "key", detail: "Paste a LocalAI API key (lai-…)" },
      {
        label: "$(mark-github) Sign in with GitHub",
        id: "github",
        detail: "Open the browser to log in, then paste your key back",
      },
    ],
    { placeHolder: "How would you like to sign in to CVSU AI DEV?", ignoreFocusOut: true }
  );
  if (!choice) return false;

  if (choice.id === "github") {
    await vscode.env.openExternal(vscode.Uri.parse(`${getBaseUrl()}/`));
    return promptCredentialAfterBrowser(secrets);
  }
  return promptApiKey(secrets);
}


/** Prompt for and store an API key, then validate it. */
async function promptApiKey(secrets: vscode.SecretStorage): Promise<boolean> {
  const target = currentTarget() === "local" ? "Local" : "Server";
  const value = await vscode.window.showInputBox({
    prompt: `Paste your ${target} API key (Leave blank if your ${target.toLowerCase()} instance does not require one)`,
    placeHolder: "sk-...",
    password: true,
    ignoreFocusOut: true
  });
  if (value === undefined) return false; // Abort on Escape/Cancel
  await setApiKey(secrets, value);
  return validate(secrets);
}

/** After the browser opened, ask what the user copied back. */
async function promptCredentialAfterBrowser(secrets: vscode.SecretStorage): Promise<boolean> {
  const pick = await vscode.window.showInformationMessage(
    "Finish signing in",
    {
      modal: true,
      detail:
        `A browser window opened for GitHub login. Once you're logged in at ${getBaseUrl()}, ` +
        "copy your API key (or session cookie) and paste it back here.",
    },
    "Paste API Key",
    "Paste Session Cookie"
  );
  if (pick === "Paste API Key") return promptApiKey(secrets);
  if (pick === "Paste Session Cookie") {
    const cookie = await vscode.window.showInputBox({
      prompt: "Paste the 'session' cookie value from your browser (DevTools → Application → Cookies)",
      placeHolder: "session=… or just the value",
      password: true,
      ignoreFocusOut: true,
    });
    if (!cookie?.trim()) return false;
    await setSessionCookie(secrets, cookie);
    return validate(secrets);
  }
  return false;
}

/** Confirm the stored credential actually works against the server. */
async function validate(secrets: vscode.SecretStorage): Promise<boolean> {
  try {
    await listModels(secrets);
    vscode.window.showInformationMessage("Signed in to CVSU AI DEV.");
    return true;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const hint = msg.includes("invite")
      ? " Your GitHub account may not be invited yet — ask the LocalAIS admin."
      : "";
    vscode.window.showErrorMessage(`Sign-in failed: ${msg}.${hint}`);
    await clearCredentials(secrets);
    return false;
  }
}

export async function signOut(secrets: vscode.SecretStorage): Promise<void> {
  await clearCredentials(secrets);
  vscode.window.showInformationMessage("Signed out of CVSU AI DEV.");
}

/** Ensure we have credentials; if not, offer to sign in. Returns true if usable. */
export async function ensureCredentials(secrets: vscode.SecretStorage): Promise<boolean> {
  if (await hasCredentials(secrets)) return true;
  const pick = await vscode.window.showInformationMessage(
    "Sign in to CVSU AI DEV to start.",
    { modal: true },
    "Sign In"
  );
  if (pick === "Sign In") return signIn(secrets);
  return false;
}
