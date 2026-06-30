import * as vscode from "vscode";

/**
 * RAG core: file chunking, vector math, and on-disk index persistence.
 * Pure-ish — only touches vscode.workspace.fs for read/write, no global state.
 */

export interface Chunk {
  id: string;          // `${file}#${startLine}`
  file: string;        // workspace-relative path
  startLine: number;
  endLine: number;
  text: string;
  vector: number[];
}

export interface FileMeta {
  hash: string;
  lineCount: number;
  chunkCount: number;
}

export interface IndexMeta {
  version: number;
  model: string;
  baseUrl: string;
  files: Record<string, FileMeta>;
}

export const INDEX_VERSION = 1;

// Chunking knobs (see plan: ~60-line windows, 10-line overlap, skip stubs).
const WINDOW = 60;
const OVERLAP = 10;
const MIN_LINES = 15;

/** Split a file's text into overlapping line-window chunks (no vectors yet). */
export function chunkFile(text: string, file: string): Omit<Chunk, "vector">[] {
  const lines = text.split("\n");
  const out: Omit<Chunk, "vector">[] = [];
  if (lines.length === 0) return out;
  const step = Math.max(1, WINDOW - OVERLAP);
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + WINDOW);
    // Skip a trailing tiny remainder (already covered by the previous window).
    if (end - start < MIN_LINES && start > 0) break;
    const slice = lines.slice(start, end).join("\n");
    if (slice.trim().length === 0) continue;
    out.push({
      id: `${file}#${start + 1}`,
      file,
      startLine: start + 1,
      endLine: end,
      text: slice,
    });
    if (end >= lines.length) break;
  }
  return out;
}

/** Fast non-crypto content hash (FNV-1a) for change detection. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ":" + text.length;
}

/** Cosine similarity between two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Rank chunks by similarity to the query vector; drop below floor; take top-K. */
export function rankTopK(
  queryVec: number[],
  chunks: Chunk[],
  k: number,
  floor = 0.25
): Array<{ chunk: Chunk; score: number }> {
  return chunks
    .map((chunk) => ({ chunk, score: cosine(queryVec, chunk.vector) }))
    .filter((r) => r.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// --- persistence (JSON files under the extension's globalStorageUri) ---

function indexDir(base: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(base, "rag-index");
}
function metaUri(base: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(indexDir(base), "meta.json");
}
function chunksUri(base: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(indexDir(base), "chunks.json");
}

export async function loadIndex(
  base: vscode.Uri
): Promise<{ meta: IndexMeta; chunks: Chunk[] } | null> {
  try {
    const metaBytes = await vscode.workspace.fs.readFile(metaUri(base));
    const meta = JSON.parse(Buffer.from(metaBytes).toString("utf8")) as IndexMeta;
    if (meta.version !== INDEX_VERSION) return null; // stale schema -> reindex
    const chunkBytes = await vscode.workspace.fs.readFile(chunksUri(base));
    const chunks = JSON.parse(Buffer.from(chunkBytes).toString("utf8")) as Chunk[];
    return { meta, chunks };
  } catch {
    return null; // no index yet
  }
}

export async function saveIndex(
  base: vscode.Uri,
  meta: IndexMeta,
  chunks: Chunk[]
): Promise<void> {
  await vscode.workspace.fs.createDirectory(indexDir(base));
  await vscode.workspace.fs.writeFile(
    metaUri(base),
    Buffer.from(JSON.stringify(meta), "utf8")
  );
  await vscode.workspace.fs.writeFile(
    chunksUri(base),
    Buffer.from(JSON.stringify(chunks), "utf8")
  );
}

export async function clearIndex(base: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(indexDir(base), { recursive: true });
  } catch {
    /* nothing to clear */
  }
}
