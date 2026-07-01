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

export class LocalAIInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(private secrets: vscode.SecretStorage) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!isAutocompleteEnabled()) return undefined;

    // Get prefix and suffix for FIM (Fill-in-the-middle) if the model supports it, 
    // or just the prefix. For simplicity, we just send the prefix.
    const prefixRange = new vscode.Range(new vscode.Position(0, 0), position);
    const prefix = document.getText(prefixRange);
    
    // Only trigger if we have some context
    if (prefix.trim().length === 0) return undefined;

    // Throttle / debounce slightly by waiting a bit to see if user is still typing
    await new Promise(resolve => setTimeout(resolve, 300));
    if (token.isCancellationRequested) return undefined;

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
        signal: token as any
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
      console.error("Autocomplete error:", e);
    }

    return undefined;
  }
}
