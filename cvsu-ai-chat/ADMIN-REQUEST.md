# Server requests to unblock CvSU-AI VSCode Chat features

These features are built/ready on the extension side but blocked because the
LocalAI server at `http://localhost:8081` currently serves **only** the chat
model. Each item below is a server-side change for the LocalAI admin.

Verified on 2026-06-29:
- `GET /v1/models` returns only `qwen2.5-coder-7b-instruct-q8_0.gguf`.
- `POST /v1/embeddings` → 500 (no embedding model loaded).
- `POST /v1/mcp/chat/completions` → 500 `"no MCP servers configured"`.
- Admin/config routes (`/system`, `/models/available`, `/models/apply`,
  `/metrics`, `/backend/monitor`) → **401/403** for our API key — tuning must be
  done by the server admin; clients cannot change backend config.

## 0. Response speed — the top user complaint (please prioritise)

Measured throughput on 2026-06-29 (non-stream, `temperature:0`):

| Metric | Measured | Healthy GPU target |
|---|---|---|
| Generation speed | **~2.4 tokens/sec** (150 tokens in 63.5s) | 30–80 tok/s |
| Time to first token | **~12 seconds** | < 1s |

~2.4 tok/s is the signature of a 7B model running **on CPU** (or a weak /
oversubscribed GPU). At this rate a 1,000-token answer takes ~7 minutes. No
client setting can fix the per-token cost — it's computed slowly at the source.

**Requested server changes (in order of impact):**

1. **Run the model on GPU** — use the CUDA/F16 LocalAI build with
   `f16: true` + `gpu_layers` set so the whole model is offloaded. Expected
   **10–30× speedup**. This is the real fix.
2. **Serve a lighter quant** — replace `q8_0` with `q4_K_M` (or `q5_K_M`).
   ~2× faster, negligible quality loss for coding.
3. **Offer a smaller model** too — e.g. `qwen2.5-coder-1.5b`/`3b` — as a fast
   option for quick asks. Give us its model id and we'll expose it in the
   extension.
4. **Preload / keep the model warm** (`single_active_backend` + a warmup call)
   to kill the ~12s cold-start latency on the first request.

The extension already caps reply length client-side (`localai.maxTokens`) to
keep responses tolerable, but that only trims length — it cannot raise tok/s.

## 1. Load an embedding model (unblocks codebase semantic search / RAG)

Add an embeddings-capable model to the LocalAI model config, e.g. a
`nomic-embed-text` or `bert`-family GGUF. After it loads, `POST /v1/embeddings`
should return vectors. Then the extension can index the codebase and answer
"where/how is X handled?" by meaning instead of substring search.

What we need from you: the **model id** of the loaded embedding model so we can
set it in the extension (`localai.embeddingModel`).

## 2. Register the localai-community MCP server (unblocks DV/budget/BIR domain tools)

The OpenAI-compatible MCP route `POST /v1/mcp/chat/completions` already exists on
the server but has no MCP servers attached. Register the `ais-mcp` server (the
one exposing `get_dv`, `budget_balance`, `find_bir_2307`, `lookup_uacs`,
`run_report`, `list_pending_dvs`, etc.) in LocalAI's MCP configuration.

Once registered, the model can call those tools server-side, and the extension
will route domain questions through `/v1/mcp/chat/completions`.

**Alternative if MCP registration isn't feasible:** expose the AIS/Frappe REST
API at a **stable, always-on URL** (not a dev port that's only up sometimes).
Give us the base URL + an auth method, and we'll call the DV/budget/BIR
endpoints directly from the extension instead.

## 3. (Optional) Raise the model context window

The chat model is loaded with a 4096-token context, which truncates large files.
Raising `context_size` (e.g. 8192 or 16384) and reloading the model lets the
extension send more file context per request. We'd then bump
`localai.contextTokenBudget` to match.

---

When any of these land, the corresponding extension feature can ship in days —
the client-side work is the easy part; the backend was the blocker.
