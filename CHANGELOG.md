# Changelog

All notable changes to docpilot-mcp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.1.0] — 2026-06-16

### Added

**Four MCP tools**
- `query_docs` — answers a natural-language question with a cited, ranked
  context block fetched from the package's own docs site. Uses a local
  Xenova/all-MiniLM-L6-v2 vector index (384-dim, fully offline) with
  transparent fallback to TF-IDF lexical ranking when the model can't load.
- `get_changelog` — returns the 10 most recent changelog entries, reading
  npm/PyPI registry metadata first and falling back to `CHANGELOG.md` on
  the package's default GitHub branch.
- `search_examples` — returns up to 10 real code examples sourced
  exclusively from the package's own `examples/` directory and `README.md`.
  Every snippet URL points to `github.com/<owner>/<repo>`.
- `resolve_method` — returns the current type signature, parameter list,
  return type, and source location for any method. For npm packages the
  signature is parsed from the `.d.ts` file inside the tarball; for PyPI
  packages from `.pyi` stubs or `.py` AST.

**Infrastructure**
- `src/net/httpClient.ts` — rate-limited (10 req/s per host), retrying
  (3× exponential backoff), 15 s timeout HTTP client.
- `src/cache/` — content-addressed cache layout; all writes are atomic
  (`*.tmp` → rename).
- `src/index/` — local hnswlib-node vector store with versioned metadata;
  auto-rebuilds on model change. Lexical TF-IDF fallback.
- `src/extractors/` — TypeScript AST walker (ts.createSourceFile),
  embedded Python AST walker (subprocess), markdown heading chunker.
- `src/sources/renderJs.ts` — Playwright singleton for JS-rendered doc
  sites (Docusaurus, VitePress, Next.js docs), with a static-cheerio-first
  heuristic that only fires Playwright when the body is SPA-thin.
- `src/server-http.ts` — HTTP/SSE transport (GET /sse, POST /messages,
  GET /health) layered on top of the stdio entry point.

**Ecosystem auto-detection**
- `query_docs`, `get_changelog`, `search_examples`, and `resolve_method`
  all accept an explicit `ecosystem` field (`"npm"` | `"pypi"`). When
  omitted, the server probes the npm registry first; if the package is not
  found there it falls back to PyPI automatically.

**Tests & CI**
- 90 vitest tests covering all 4 tools, the vector cache, JS rendering
  fallback, changelog parsing, and method signature extraction — all
  offline using recorded fixtures under `test/fixtures/`.
- GitHub Actions CI runs on Node 20 and 22 across every push and PR.
- Live verification scripts in `scripts/` for all 4 tools against real
  packages (stripe, requests).
