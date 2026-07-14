# RAG index over the source archive

Passage-level retrieval across every document in `sources/` so any claim in the docs
can be traced to (and verified against) the exact page that supports it.

## Pipeline (run in order; all resumable)

```
/opt/homebrew/bin/python3.13 rag/extract.py    # per-page text; OCR for image-only pages
rag/.venv/bin/python rag/chunk.py              # ~2,800-char chunks with page metadata
rag/.venv/bin/python rag/embed.py              # Qwen3-Embedding-4B (Q8) on bigmantower:11434
rag/.venv/bin/python rag/query.py "question"   # hybrid vector+BM25 search, returns file + pages + snippet
```

- Embeddings: `hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q8_0` served by Ollama on the 3090
  (`OLLAMA_URL`/`EMBED_MODEL` env vars override).
- Store: `rag/data/index.db` — sqlite-vec (2560-dim cosine) + FTS5 BM25, fused by RRF.
- `rag/data/` and the venv are local-only (gitignored); scripts are committed.

Built July 2026 after a directional error was found in doc 08 — the goal is exact
passage sourcing ("file, p. N") for every citation, and machine re-verification of
every claim in the archive against these passages.
