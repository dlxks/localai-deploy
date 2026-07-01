import * as vscode from "vscode";
import { getBaseUrl, getApiKeySecretKey } from "./client";

export function getAutocompleteModel(): string {
  const cfg = vscode.workspace.getConfiguration("localai");
  return cfg.get<string>("autocomplete.model") || "lfm2.b-1.2b-instruct";
}

export function isAutocompleteEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration("localai");
  return cfg.get<boolean>("autocomplete.enabled") ?? false;
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export class LocalAIInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(private secrets: vscode.SecretStorage) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!isAutocompleteEnabled()) return undefined;

    const prefixRange = new vscode.Range(new vscode.Position(0, 0), position);
    const prefix = document.getText(prefixRange);
    if (prefix.trim().length === 0) return undefined;

    // Debounce: cancel any pending timer before starting a new one.
    clearTimeout(debounceTimer);
    await new Promise<void>((resolve) => { debounceTimer = setTimeout(resolve, 300); });
    if (token.isCancellationRequested) return undefined;

    // Wire CancellationToken to a real AbortController so fetch actually aborts.
    const ac = new AbortController();
    const sub = token.onCancellationRequested(() => ac.abort());
    try {
      const apiKey = await this.secrets.get(getApiKeySecretKey()) || process.env.LOCALAI_API_KEY;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Origin": getBaseUrl(),
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const res = await fetch(`${getBaseUrl()}/v1/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: getAutocompleteModel(),
          prompt: prefix,
          max_tokens: 60,
          temperature: 0.1,
          stop: ["\n\n", "```"]
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        console.error("Autocomplete failed: ", res.statusText);
        return undefined;
      }

      const json = await res.json() as any;
      const text = json?.choices?.[0]?.text;
      if (text) {
        return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
      }
    } catch (e) {
      // Ignore abort errors (user kept typing); log the rest.
      if (!(e instanceof Error && e.name === "AbortError")) {
        console.error("Autocomplete error:", e);
      }
    } finally {
      sub.dispose();
    }

    return undefined;
  }
}
