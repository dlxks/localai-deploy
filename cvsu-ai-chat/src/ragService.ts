import * as vscode from "vscode";
import { embeddings, getEmbeddingModel, getBaseUrl } from "./client";
import { EXCLUDE_GLOB } from "./tools";
import {
  Chunk,
  IndexMeta,
  INDEX_VERSION,
  chunkFile,
  hashText,
  rankTopK,
  loadIndex,
  saveIndex,
  clearIndex,
} from "./rag";

// Only embed real source/text files (on top of EXCLUDE_GLOB).
const SOURCE_EXT = new RegExp(
  "\\.(ts|tsx|js|jsx|py|java|go|rs|rb|php|c|h|cpp|hpp|cs|swift|kt|scala|sh|" +
    "sql|json|ya?ml|toml|md|txt|css|scss|html|vue|svelte)$",
  "i"
);

const EMBED_BATCH = 16;

/**
 * Stateful RAG service: holds the in-memory index, builds/persists it, and
 * answers retrieval queries. One instance per extension activation.
 */
export class RagService {
  private chunks: Chunk[] = [];
  private indexed = false;
  private busy = false;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage
  ) {}

  get ready(): boolean {
    return this.indexed && this.chunks.length > 0;
  }
  get isBusy(): boolean {
    return this.busy;
  }
  stats() {
    const files = new Set(this.chunks.map((c) => c.file));
    return { chunks: this.chunks.length, files: files.size };
  }

  /** Load a previously-saved index into memory (called at activation). */
  async load(): Promise<void> {
    const loaded = await loadIndex(this.storageUri);
    if (loaded) {
      this.chunks = loaded.chunks;
      this.indexed = true;
    }
  }

  /** Full (re)index of the first workspace folder. Cancellable. */
  async buildIndex(token?: vscode.CancellationToken, onProgress?: (msg: string) => void): Promise<void> {
    if (this.busy) {
      throw new Error("Indexing already in progress.");
    }
    this.busy = true;
    try {
      const uris = await vscode.workspace.findFiles("**/*", EXCLUDE_GLOB, 5000);
      const files = uris.filter((u) => SOURCE_EXT.test(u.path));
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.path ?? "";
      const rel = (p: string) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);

      const pending: Omit<Chunk, "vector">[] = [];
      const meta: IndexMeta = {
        version: INDEX_VERSION,
        model: getEmbeddingModel(),
        baseUrl: getBaseUrl(),
        files: {},
      };

      let fileNo = 0;
      for (const uri of files) {
        if (token?.isCancellationRequested) throw new Error("Indexing cancelled.");
        fileNo++;
        let text: string;
        try {
          text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        } catch {
          continue;
        }
        if (text.length > 200_000) continue; // skip very large/generated files
        const r = rel(uri.path);
        const fileChunks = chunkFile(text, r);
        pending.push(...fileChunks);
        meta.files[r] = { hash: hashText(text), lineCount: text.split("\n").length, chunkCount: fileChunks.length };
        if (fileNo % 10 === 0) onProgress?.(`Scanned ${fileNo}/${files.length} files…`);
      }

      // Embed in batches, preserving order; build the vectorized chunk list.
      const out: Chunk[] = [];
      for (let i = 0; i < pending.length; i += EMBED_BATCH) {
        if (token?.isCancellationRequested) throw new Error("Indexing cancelled.");
        const batch = pending.slice(i, i + EMBED_BATCH);
        const vecs = await embeddings(this.secrets, batch.map((c) => c.text));
        batch.forEach((c, j) => {
          if (vecs[j]) out.push({ ...c, vector: vecs[j] });
        });
        onProgress?.(`Embedded ${Math.min(i + EMBED_BATCH, pending.length)}/${pending.length} chunks…`);
      }

      this.chunks = out;
      this.indexed = true;
      await saveIndex(this.storageUri, meta, out);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Retrieve the top-K chunks for a query and format them as a context block.
   * Returns "" if the index is empty or embedding fails. Respects a char budget
   * so the injected context never blows the model's window.
   */
  async retrieve(query: string, topK = 5, charBudget = 4000): Promise<string> {
    if (!this.ready || !query.trim()) return "";
    let qvec: number[];
    try {
      const v = await embeddings(this.secrets, [query]);
      qvec = v[0];
    } catch {
      return ""; // degrade gracefully — chat proceeds without RAG
    }
    if (!qvec) return "";

    const hits = rankTopK(qvec, this.chunks, topK);
    if (hits.length === 0) return "";

    const blocks: string[] = [];
    let used = 0;
    for (const { chunk } of hits) {
      const block = `File: ${chunk.file} (lines ${chunk.startLine}-${chunk.endLine})\n\`\`\`\n${chunk.text}\n\`\`\``;
      if (used + block.length > charBudget) break;
      blocks.push(block);
      used += block.length;
    }
    if (blocks.length === 0) return "";
    return `Relevant code from the workspace (retrieved by semantic search):\n\n${blocks.join("\n\n")}`;
  }

  async clear(): Promise<void> {
    this.chunks = [];
    this.indexed = false;
    await clearIndex(this.storageUri);
  }
}
