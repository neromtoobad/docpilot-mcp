# docpilot-mcp cache format

This document describes the on-disk layout of the local cache used by
`docpilot-mcp` to (a) skip refetching upstream artifacts on repeat
calls and (b) avoid re-running the embedding model at query time.

## Root

`$DOCPILOT_CACHE_DIR` (default `~/.cache/docpilot-mcp`).

Override per-process with `DOCPILOT_CACHE_DIR=...`. Tests use a fresh
`mkdtempSync(...)` per test to avoid leaking state across runs.

## Layout

```
$DOCPILOT_CACHE_DIR/
  index/<ecosystem>/<package>/<version>/
    chunks.jsonl           # one chunk per line (AC-3)
    vector.bin             # hnswlib-node ANN index (AC-7)
    vector-meta.json       # { model, dim, m, efConstruction, efSearch, count, builtAt }
  raw/<ecosystem>/<package>/<version>/
    <source>.html          # cached page HTML / raw bytes
```

The two top-level namespaces (`index/`, `raw/`) are independent: a
package can have raw HTML cached without a built index (e.g. when the
chunker is disabled) and vice versa.

## `chunks.jsonl` schema

JSON Lines file — one chunk per line, no trailing comma. Each line is
the JSON encoding of:

```ts
interface Chunk {
  index: number;     // 0-indexed chunk number within the page
  section: string;   // nearest preceding heading (or "(untitled)")
  text: string;      // raw chunk text
  url: string;       // URL the chunk was extracted from
}
```

A line that fails to parse is silently skipped on read (the writer
is atomic via `*.tmp → rename`, so a partial write is the only case
where a parse failure can occur).

## `vector.bin` schema

The file is the on-disk format of the `hnswlib-node`
`HierarchicalNSW` index in `'cosine'` space. The exact byte layout is
hnswlib's and is not part of our contract; the *contract* is the
`vector-meta.json` file that sits next to it.

## `vector-meta.json` schema

```ts
interface VectorIndexMeta {
  model: string;            // e.g. "Xenova/all-MiniLM-L6-v2"
  dim: number;              // embedding dimensionality (384 for MiniLM-L6-v2)
  m: number;                // hnswlib M (max outgoing connections)
  efConstruction: number;   // hnswlib efConstruction
  efSearch: number;         // hnswlib efSearch
  count: number;            // number of vectors indexed
  builtAt: string;          // ISO-8601 timestamp
}
```

The `{model, dim}` pair is the contract: if a request comes in
where the embedder is on a different model or dimensionality, the
server rebuilds the index from `chunks.jsonl` rather than try to
query the old vectors with a mismatched model.

## Lifecycle

### First call to `query_docs` for a new `(package, version)`

1. **Chunks**: missing → fetch the docs page, run `chunkText()`, save
   to `chunks.jsonl`.
2. **Embedder**: lazily load the local `@xenova/transformers` model
   (`Xenova/all-MiniLM-L6-v2`, 384-dim). If the load fails (network
   down, ONNX runtime missing, etc.) the server logs a `WARN` and
   falls back to the TF-IDF ranker in `src/index/lexical.ts` for
   that call.
3. **Vector index**: missing → for each chunk, embed the text and
   add the vector to a fresh hnswlib index; persist as
   `vector.bin` + `vector-meta.json`.

### Subsequent calls (cache=hit)

1. **Chunks**: present → load from `chunks.jsonl`.
2. **Embedder**: cached in a process-wide singleton — no reload.
3. **Vector index**: present and meta matches `{model, dim}` →
   load `vector.bin` and run k-NN against the cached question
   embedding. If meta mismatches (model upgrade, dimension
   change), the index is silently rebuilt from `chunks.jsonl`.

### Concurrency

- The chunk write is atomic (write `*.tmp`, then `rename(2)`).
- The vector index write is atomic: the hnswlib `writeIndex` is
  called against a `.tmp` path that is then renamed into place.
- The metadata write is also atomic: `*.tmp` → `rename(2)`.
- Concurrent writers to the same `(package, version)` may race on
  the rename step; the last writer wins. The reader is tolerant
  of a partially-written `vector.bin` by checking `vector-meta.json`
  first — if the meta is missing or corrupt, the index is
  rebuilt.

### Cache invalidation

- The index is **never** invalidated on a server upgrade: a
  model change is detected via the meta file and the index is
  rebuilt lazily on the next call.
- The user can wipe the entire cache by removing
  `$DOCPILOT_CACHE_DIR/`.
- Per-package wipes are also possible:
  `rm -rf "$DOCPILOT_CACHE_DIR/index/<ecosystem>/<package>"`.

## Performance

The plan's AC-7 verification matrix says:

> "Re-issuing the same call returns within 500 ms locally for a
>  500-chunk index."

Once the index is on disk, the work on the second call is:
- read `chunks.jsonl` (a few MB for 500 chunks),
- read `vector-meta.json` (a few hundred bytes),
- `mmap` `vector.bin` (a few MB for 500×384-dim vectors with hnswlib's
  default `M=16, efConstruction=200`),
- embed the question (one inference call, <50 ms on CPU),
- run k-NN (sub-millisecond for `k=5`).

So the second call is dominated by I/O on `vector.bin` and the
question embedding. The first call also embeds 500 chunks (one
inference call each, ~50 ms each on CPU) — about 25 s on a single
core, but parallelisable by the embedder in the future.

## Failure modes

- **Model download fails**: `loadEmbedder()` returns `null`; the
  server logs a `WARN` and falls back to the lexical ranker. The
  answer is still produced; it's just not vector-ranked.
- **hnswlib native binding missing**: `import('hnswlib-node')` throws;
  the embedder load path is unaffected, but the vector build path
  will fail. The handler catches that and falls back to lexical.
- **Out-of-disk**: the atomic rename succeeds but the write itself
  throws; the meta file is never written, so the reader will treat
  the index as missing and rebuild on the next call.
